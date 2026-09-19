import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import { cashMovements, lineOwed } from './revenue-basis'
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
 *     from the Revenue & Bookings and P&L reports (the shared cash-movement
 *     basis in ./revenue-basis.ts);
 *   * each sale counted ONCE. Counting `order_items` as well would double every
 *     billed plate, which is precisely the trap this choice avoids;
 *   * the HISTORICAL price, not today's menu price.
 *
 * ── WHAT "REVENUE" MEANS HERE: MONEY TAKEN ──────────────────────────────────
 * Captured payments, apportioned to food by food's share of the bill — the
 * shared definition in ./revenue-basis.ts, the same one Revenue & Bookings and
 * Profit & Loss use. An unpaid food bill therefore contributes NOTHING, and a
 * part-paid one contributes only what was collected.
 *
 * It used to be `SUM(invoice_items.line_total)` for any issued-or-paid
 * invoice: gross, and on an accrual basis. Both changed together, because a
 * report headed "revenue" that counts bills nobody has paid is not revenue.
 *
 * QUANTITY is deliberately NOT apportioned. Three plates sold are three plates
 * sold whether or not the bill has been settled — that is an operational fact
 * about the kitchen, and pro-rating it would produce fractional plates. So
 * `quantity` counts everything billed while `paidRevenue` counts only money.
 * The two answer different questions and the screen labels them as such.
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
  /** Plates billed, settled or not — an operational count, never apportioned. */
  quantity: number
  /** Money actually captured against this item. See the note above. */
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
 *
 * `channel` (M21 #7) narrows both reports to invoices whose booking is that
 * channel — same optional filter, same 'walkin'/'reserved' meaning, as
 * getDailyRevenue's (lib/reports/daily-revenue.ts). Food/membership sales
 * don't carry a channel of their own; this classifies by the BILL they were
 * sold on, same as revenue does.
 */
export async function getSalesReport(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null; channel?: 'walkin' | 'reserved' | null },
): Promise<SalesReport> {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }
  // Module gate (M16 #2): the plan must include Reports. Authoritative —
  // the pages redirect for presentation, this is what actually refuses.
  await requireEntitlement(ctx, 'module.reports')

  const { range, branchId, channel } = options
  const tenantId = ctx.tenant.id

  return withUser(ctx.user.id, async (tx) => {
    // ── food ─────────────────────────────────────────────────────────────────
    // Dated by when the MONEY was taken, in the branch's local day — the same
    // basis the revenue dashboard uses, so a food sale lands on the day its
    // revenue does. The kitchen's own order timestamp is deliberately not
    // used: this is a money report, not a service one.
    //
    // Each payment is apportioned to a food LINE by that line's share of the
    // whole bill, so a payment settling a mixed booking-and-food invoice
    // contributes to both in proportion and to neither twice.
    // Movements (payments and refunds) are collapsed to ONE net figure per
    // invoice first, so joining to invoice_items counts each plate's qty once
    // — never once per payment/refund — while the money still nets refunds.
    const food = await tx.execute(sql`
      with inv_net as (
        select invoice_id, sum(amount) as net_amount, max(all_lines) as all_lines
          from ${cashMovements(tenantId, range, branchId, channel)} m
         group by invoice_id
      )
      select ii.description                                                  as item_name,
             sum(ii.qty)::float                                              as quantity,
             sum(n.net_amount * ${lineOwed} / nullif(n.all_lines, 0))::float as gross_revenue,
             count(distinct ii.invoice_id)::int                             as invoices
        from inv_net n
        join public.invoice_items ii
          on ii.invoice_id = n.invoice_id
         and ii.tenant_id = ${tenantId}
         and ii.kind = 'food'
        join public.invoices inv on inv.id = n.invoice_id
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
    // Two different questions, so two different dates — and they are labelled
    // as such on screen:
    //
    //   SOLD      memberships created in the window, dated by created_at. An
    //             operational count; a free membership (no invoice at all)
    //             still counts, at zero revenue.
    //   REVENUE   money captured against the membership's invoice, dated by
    //             when it was taken, through the shared basis. A membership
    //             sold on credit therefore counts as sold and earns nothing
    //             until it is paid for.
    const memberships = await tx.execute(sql`
      with inv_net as (
        select invoice_id, sum(amount) as net_amount, max(all_lines) as all_lines
          from ${cashMovements(tenantId, range, branchId, channel)} m
         group by invoice_id
      ),
      sold as (
        select cm.plan_id, cm.plan_name,
               count(*)::int as sold,
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
      ),
      collected as (
        select cm.plan_id, cm.plan_name,
               sum(n.net_amount * ${lineOwed} / nullif(n.all_lines, 0))::float as revenue
          from inv_net n
          join public.invoice_items ii
            on ii.invoice_id = n.invoice_id
           and ii.tenant_id = ${tenantId}
           and ii.kind = 'membership'
          join public.invoices inv on inv.id = n.invoice_id
          join public.customer_memberships cm
            on cm.invoice_id = n.invoice_id
           and cm.tenant_id = inv.tenant_id
         group by cm.plan_id, cm.plan_name
      )
      select coalesce(s.plan_id, c.plan_id)::text     as plan_id,
             coalesce(s.plan_name, c.plan_name)       as plan_name,
             coalesce(s.sold, 0)::int                 as sold,
             coalesce(c.revenue, 0)::float            as revenue,
             coalesce(s.cancelled, 0)::int            as cancelled
        from sold s
        full outer join collected c
          on c.plan_id = s.plan_id and c.plan_name = s.plan_name
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
