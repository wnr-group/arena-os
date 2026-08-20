import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import type { CsvColumn } from './csv'
import type { DateRange } from './date-range'

/**
 * Food & Membership sales reports (AROS-66).
 *
 * ── WHERE FOOD SALES COME FROM, AND WHY NOT `order_items` ───────────────────
 * The canonical source is `invoice_items` where `kind = 'food'`, joined to a
 * live invoice. Not `order_items`. AROS-39 made the invoice the financial
 * record of a food sale:
 *
 *     order_items ──(loadFoodLines, priced)──▶ invoice_items(kind='food')
 *          │                                        │
 *          └── orders.status flips to 'billed' ─────┘  (so it can never be
 *              and back to 'open' if the invoice        billed a second time)
 *              is voided — lib/billing/refunds.ts
 *
 * `order_items` is the OPERATIONAL record (what the kitchen cooked);
 * `invoice_items` is the FINANCIAL one (what the customer was charged), with
 * qty, unit_price and line_total frozen at billing time. Reporting off the
 * invoice therefore gets, for free and without a single extra rule:
 *
 *   * abandoned / still-open orders excluded — never invoiced;
 *   * cancelled orders excluded — never invoiced;
 *   * draft and VOID invoices excluded — same status filter revenue uses, so a
 *     voided bill's food disappears from this report exactly as it disappears
 *     from mv_daily_revenue;
 *   * each sale counted ONCE. Counting `order_items` as well would double every
 *     billed plate, which is precisely the trap this choice avoids;
 *   * the HISTORICAL price, not today's menu price.
 *
 * ── WHAT "REVENUE" MEANS HERE ───────────────────────────────────────────────
 * `SUM(invoice_items.line_total)` = Σ qty × unit_price as billed: BEFORE any
 * invoice-level discount (promo, membership, loyalty) and BEFORE GST, because
 * lib/billing/pricing.ts applies those to the invoice as a whole and allocates
 * tax across rate groups — it never writes them back onto a line. There is no
 * per-line net to be had, and inventing a pro-rata split would be a business
 * rule nobody has agreed. So this is deliberately named GROSS, and it will not
 * add up to the net revenue on the AROS-65 dashboard. Documented on screen too.
 *
 * ── ITEM IDENTITY ───────────────────────────────────────────────────────────
 * Grouped by `invoice_items.description` — the item name snapshotted when the
 * order was taken. Never joined to `menu_items`, so renaming or deleting a menu
 * item cannot rewrite a past report. The consequence is deliberate: a renamed
 * item appears as two rows, one per name it was sold under, which is what a
 * historical report should show.
 *
 * ── MEMBERSHIP SALES ────────────────────────────────────────────────────────
 * From `customer_memberships`, which AROS-60 snapshots at purchase:
 * `plan_name`, `price_paid`, duration and benefits are all copies taken at the
 * moment of sale, so `membership_plans` is never read here and a repriced or
 * renamed plan cannot move historical figures.
 *
 * `price_paid` IS the billed amount, by construction:
 * purchaseMembership() raises the invoice through issueMembershipInvoice()
 * for exactly `price_paid` and tenders it, all in one transaction — so the
 * membership, its invoice and its payment commit together or not at all. The
 * test script reconciles the reported figure against the linked invoice and its
 * payments rather than taking that on trust.
 */

export type FoodSalesRow = {
  /** The item name as billed (historical snapshot). */
  itemName: string
  quantity: number
  /** Σ line_total — before invoice-level discount and before GST. */
  grossRevenue: number
  /** Distinct invoices this item appeared on. */
  invoices: number
}

export type MembershipSalesRow = {
  planId: string
  /** The plan name as sold (historical snapshot). */
  planName: string
  sold: number
  /** Σ price_paid — the amount actually charged at purchase. */
  revenue: number
  /** Of `sold`, how many have since been cancelled. Still sales: cancelling
   *  does not refund (lib/memberships/customer-memberships.ts). */
  cancelled: number
}

export type SalesReport = {
  food: FoodSalesRow[]
  memberships: MembershipSalesRow[]
  totals: {
    foodQuantity: number
    foodGrossRevenue: number
    membershipsSold: number
    membershipRevenue: number
  }
}

/**
 * Both sales reports for `range`, in one RLS-scoped transaction.
 *
 * Aggregated entirely in Postgres — two GROUP BY queries, constant regardless
 * of how many plates or plans were sold. Owner/manager only, refused in this
 * layer so the guard cannot be skipped by calling the reader directly.
 */
export async function getSalesReport(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null },
): Promise<SalesReport> {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }

  const { range, branchId } = options
  const tenantId = ctx.tenant.id

  return withUser(ctx.user.id, async (tx) => {
    // ── food ─────────────────────────────────────────────────────────────────
    // Dated by the INVOICE's issued_at in the branch's local day — the same
    // basis mv_daily_revenue uses (migration 0032), so a food sale lands on the
    // same day as the revenue it is part of. The kitchen's own order timestamp
    // is deliberately not used: the sale happens when it is billed.
    const food = await tx.execute(sql`
      select ii.description                as item_name,
             sum(ii.qty)::float            as quantity,
             sum(ii.line_total)::float     as gross_revenue,
             count(distinct ii.invoice_id)::int as invoices
        from public.invoice_items ii
        join public.invoices i
          on i.id = ii.invoice_id
         and i.tenant_id = ii.tenant_id
        join public.branches b on b.id = i.branch_id
        join public.tenants  t on t.id = i.tenant_id
       where ii.tenant_id = ${tenantId}
         and ii.kind = 'food'
         and i.status in ('issued','paid')
         and i.issued_at is not null
         and ((i.issued_at at time zone coalesce(b.timezone, t.timezone))::date)
             between ${range.start}::date and ${range.end}::date
         ${branchId ? sql`and i.branch_id = ${branchId}` : sql``}
       group by ii.description
       order by gross_revenue desc, item_name
    `)

    // ── memberships ──────────────────────────────────────────────────────────
    // Dated by created_at — when the sale was finalised. NOT starts_at (which a
    // future-dated membership would push forward) and emphatically NOT
    // expires_at, which is when the thing runs out, not when it was bought.
    //
    // customer_memberships carries no branch_id (a membership is tenant-wide,
    // not sold "at" a branch), so the day is the TENANT's local day and the
    // branch filter cannot apply — see the note in the UI.
    //
    // A voided invoice un-sells the membership: same rule as revenue. A free
    // membership has no invoice at all (purchaseMembership only bills
    // when price > 0) and still counts, at zero revenue.
    const memberships = await tx.execute(sql`
      select cm.plan_id::text                                as plan_id,
             cm.plan_name                                    as plan_name,
             count(*)::int                                   as sold,
             sum(cm.price_paid)::float                       as revenue,
             count(*) filter (where cm.status = 'cancelled')::int as cancelled
        from public.customer_memberships cm
        join public.tenants t on t.id = cm.tenant_id
        left join public.invoices i
          on i.id = cm.invoice_id
         and i.tenant_id = cm.tenant_id
       where cm.tenant_id = ${tenantId}
         and (cm.invoice_id is null or i.status <> 'void')
         and ((cm.created_at at time zone t.timezone)::date)
             between ${range.start}::date and ${range.end}::date
       group by cm.plan_id, cm.plan_name
       order by revenue desc, plan_name
    `)

    const foodRows: FoodSalesRow[] = (food.rows as FoodRow[]).map((r) => ({
      itemName: r.item_name,
      quantity: round2(Number(r.quantity)),
      grossRevenue: round2(Number(r.gross_revenue)),
      invoices: Number(r.invoices),
    }))

    const membershipRows: MembershipSalesRow[] = (memberships.rows as MembershipRow[]).map((r) => ({
      planId: r.plan_id,
      planName: r.plan_name,
      sold: Number(r.sold),
      revenue: round2(Number(r.revenue)),
      cancelled: Number(r.cancelled),
    }))

    return {
      food: foodRows,
      memberships: membershipRows,
      totals: {
        foodQuantity: round2(foodRows.reduce((n, r) => n + r.quantity, 0)),
        foodGrossRevenue: round2(foodRows.reduce((n, r) => n + r.grossRevenue, 0)),
        membershipsSold: membershipRows.reduce((n, r) => n + r.sold, 0),
        membershipRevenue: round2(membershipRows.reduce((n, r) => n + r.revenue, 0)),
      },
    }
  })
}

export const FOOD_SALES_CSV_COLUMNS: readonly CsvColumn<FoodSalesRow>[] = [
  { header: 'Item', value: (r) => r.itemName },
  { header: 'Qty sold', value: (r) => r.quantity },
  { header: 'Invoices', value: (r) => r.invoices },
  { header: 'Gross revenue', value: (r) => r.grossRevenue.toFixed(2) },
]

export const MEMBERSHIP_SALES_CSV_COLUMNS: readonly CsvColumn<MembershipSalesRow>[] = [
  { header: 'Plan', value: (r) => r.planName },
  { header: 'Plans sold', value: (r) => r.sold },
  { header: 'Cancelled since', value: (r) => r.cancelled },
  { header: 'Revenue', value: (r) => r.revenue.toFixed(2) },
]

type FoodRow = { item_name: string; quantity: number | string; gross_revenue: number | string; invoices: number | string }
type MembershipRow = {
  plan_id: string
  plan_name: string
  sold: number | string
  revenue: number | string
  cancelled: number | string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
