import 'server-only'
import { sql, type SQL } from 'drizzle-orm'

/**
 * THE definition of realized (paid) revenue, in one place.
 *
 * Every revenue figure in the product is built from the fragments below:
 *
 *   Revenue & Bookings   lib/reports/daily-revenue.ts
 *   Profit & Loss        lib/reports/pnl.ts
 *   Food / Membership    lib/reports/sales.ts
 *
 * ── CASH BASIS: MONEY TAKEN, NOT MONEY BILLED ───────────────────────────────
 *
 * Revenue is a CAPTURED PAYMENT. An invoice on its own is not revenue, however
 * large: a ₹500 bill with nothing collected contributes ₹0, a ₹500 bill with
 * ₹200 collected contributes ₹200, and a ₹500 bill paid in full contributes
 * ₹500. This replaces the earlier accrual basis, where raising the bill was
 * enough.
 *
 * "Captured" is not redefined here. It is `payments.status = 'captured'` —
 * exactly what capturedTotal() and getInvoiceSettlement() (lib/billing/
 * payments.ts) mean by paid, and what the payment panel and the receipt's PAID
 * badge already show. Pending and failed tenders are not money in the till.
 *
 * ── THE REPORTING DATE ──────────────────────────────────────────────────────
 *
 * `payments.created_at` — when the money was taken. NOT the invoice date, and
 * emphatically not the booking date.
 *
 * That column really is the capture moment: every payment in this codebase is
 * INSERTED already captured (lib/billing/payments.ts, lib/billing/
 * wallet-payments.ts), and the only UPDATE to `status` is the refund flip in
 * lib/billing/refunds.ts. There is no pending→captured transition for
 * created_at to lag behind.
 *
 * So a booking played next Tuesday, billed and paid today, is TODAY's revenue.
 * The service date never enters the query — which is the whole point: a future
 * booking cannot fall out of a report just for being in the future.
 *
 * ── VOIDS AND REFUNDS ───────────────────────────────────────────────────────
 *
 * A VOID invoice contributes nothing, even if money was taken against it —
 * voiding is how a sale is struck off, and lib/billing/refunds.ts requires the
 * money to be refunded first anyway.
 *
 * Refunds follow the established rule and are NOT subtracted here, because
 * they do not need to be: recordRefund() flips a fully-refunded payment to
 * `status = 'refunded'`, which removes it from `captured` and therefore from
 * revenue, on its own. A PARTIAL refund deliberately leaves the payment
 * captured at its full amount — the same thing capturedTotal(), the payment
 * panel and the receipt all report. Netting partial refunds off here would
 * make this the only figure in the product that disagrees with them.
 *
 * ── STORED VALUE: WHY A WALLET TOP-UP IS NOT A SALE ─────────────────────────
 *
 * Selling wallet credit takes cash, but it is a deposit, not a sale — the
 * customer is owed goods. Counting the top-up AND the later spend would count
 * the same rupee twice, which is exactly the double counting this report must
 * not do. So:
 *
 *   * invoices whose items are a wallet TOP-UP are excluded entirely;
 *   * a wallet TENDER against a real bill is included, because that is the
 *     moment the deposit becomes a sale.
 *
 * ── ALLOCATING ONE PAYMENT ACROSS REVENUE SOURCES ───────────────────────────
 *
 * A payment settles an invoice, not a line, so a bill holding both a ₹75
 * booking and ₹120 of food has to be split.
 *
 * Each LINE is first reduced to what it actually contributed to the bill,
 * rebuilding priceBill()'s own arithmetic from the frozen columns:
 *
 *     owed(line) = (line_total − line's pro-rata share of the discount)
 *                  × (1 + its own tax_rate/100)
 *
 * — discount pro rata by line value, because that is exactly how priceBill()
 * spreads it, and tax at the LINE's OWN rate, because invoice_items carries it.
 * Splitting by bare line_total instead would hand a 0%-rated booking line part
 * of the GST collected on 5%-rated food, which is wrong on every mixed-rate
 * bill — and almost every bill with food on it is mixed-rate.
 *
 * Those owed amounts sum to the invoice total, so apportioning a payment by
 * each kind's share of them splits the money exactly: the parts add back to
 * the payment, and no rupee is counted under two sources.
 */

/** Payment states that are money in the till. */
export const CAPTURED_PAYMENT_STATUS = 'captured'

/**
 * The calendar day a PAYMENT belongs to, on the branch's wall clock (falling
 * back to the tenant's).
 *
 * The session TimeZone is UTC, so a bare `created_at::date` would push every
 * IST tender after 05:30 local into the previous day. The branch is the
 * invoice's, so a payment is attributed where the sale was made.
 *
 * Requires `payments p`, `branches b` and `tenants t` in scope.
 */
export const paymentLocalDay: SQL = sql`((p.created_at at time zone coalesce(b.timezone, t.timezone))::date)`

/**
 * What each invoice's lines are OWED, split by kind — the shares a payment is
 * apportioned by. See the note above for the arithmetic.
 *
 * `topup_lines` is carried so the caller can drop deposit invoices entirely;
 * stored value is never revenue.
 */
/**
 * What ONE invoice line contributed to its bill: its value less its pro-rata
 * share of the invoice discount, plus GST at its own rate.
 *
 * The single definition of that arithmetic — invoiceKindShares() groups it by
 * kind, and any query needing a per-ITEM share (the food and membership sales
 * reports) uses the very same expression, so a part can never be measured on a
 * different scale from the whole it is divided by.
 *
 * Requires `ii` (invoice_items) and `inv` (invoices) in scope.
 */
export const lineOwed: SQL = sql`((ii.line_total - inv.discount * ii.line_total / nullif(inv.subtotal, 0)) * (1 + ii.tax_rate / 100))`

export const invoiceKindShares: SQL = sql`
  select ii.invoice_id,
         coalesce(sum(owed) filter (where kind = 'booking'), 0)      as booking_lines,
         coalesce(sum(owed) filter (where kind = 'food'), 0)         as food_lines,
         coalesce(sum(owed) filter (where kind = 'membership'), 0)   as membership_lines,
         coalesce(sum(owed) filter (where kind = 'wallet_topup'), 0) as topup_lines,
         coalesce(sum(owed), 0)                                      as all_lines
    from (
      select ii.invoice_id, ii.kind, ${lineOwed} as owed
        from public.invoice_items ii
        join public.invoices inv on inv.id = ii.invoice_id
    ) ii
   group by ii.invoice_id
`

/**
 * The joins every paid-revenue query uses, always under the same aliases so no
 * caller can date or attribute a payment differently.
 */
export const paidRevenueJoins: SQL = sql`
  from public.payments p
  join public.invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id
  join public.branches b on b.id = i.branch_id
  join public.tenants  t on t.id = i.tenant_id
  left join (${invoiceKindShares}) k on k.invoice_id = i.id
`

/**
 * The payments that count, for one tenant and one inclusive local-date range.
 *
 * A wallet top-up invoice is excluded here rather than netted out later, so no
 * figure downstream ever contains it.
 */
export function paidRevenueFilter(
  tenantId: string,
  range: { start: string; end: string },
  branchId?: string | null,
): SQL {
  return sql`
    p.tenant_id = ${tenantId}
    and p.status = 'captured'
    and i.status <> 'void'
    and coalesce(k.topup_lines, 0) = 0
    and ${paymentLocalDay} between ${range.start}::date and ${range.end}::date
    ${branchId ? sql`and i.branch_id = ${branchId}` : sql``}
  `
}

/**
 * How much of one payment belongs to `kind`.
 *
 * By the kind's share of what the invoice's lines are owed. An invoice with no
 * items at all (there should be none) has no share to take, so it contributes
 * to no source while still counting in the collected total — the totals stay
 * truthful rather than silently absorbing it somewhere.
 */
export function paidForKind(kind: 'booking' | 'food' | 'membership'): SQL {
  const column =
    kind === 'booking' ? sql`k.booking_lines` : kind === 'food' ? sql`k.food_lines` : sql`k.membership_lines`
  return sql`(p.amount * coalesce(${column}, 0) / nullif(k.all_lines, 0))`
}

/**
 * What fraction of its invoice a payment settles — for scaling the invoice's
 * own gross / discount / tax onto the part actually collected. A fully paid
 * bill scales by 1 and reports its exact figures.
 */
export const collectionRatio: SQL = sql`(p.amount / nullif(i.total, 0))`
