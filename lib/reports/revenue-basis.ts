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
 * ── CASH BASIS: MONEY TAKEN, NET OF MONEY GIVEN BACK ────────────────────────
 *
 * Revenue is the cash actually held: a CAPTURED PAYMENT counts as money in, a
 * REFUND counts as money out, and revenue for a period is the one minus the
 * other. An invoice on its own is not revenue, however large: a ₹500 bill with
 * nothing collected contributes ₹0, a ₹500 bill with ₹200 collected
 * contributes ₹200, and a ₹500 bill paid in full then ₹200 refunded
 * contributes ₹300. This replaces the earlier accrual basis, where raising the
 * bill was enough.
 *
 * ── THE REPORTING DATE — AND WHY REFUNDS ARE THEIR OWN MOVEMENT ──────────────
 *
 * Money in is dated by `payments.created_at`; money out by
 * `refunds.created_at` — each on the day it actually happened, NOT the invoice
 * or booking date. A payment taken in January and refunded in March adds to
 * January and subtracts from March; re-running January's report after the
 * March refund still shows January's figure, because a refund never reaches
 * back and rewrites the day the sale was made. That is why a payment and a
 * refund are modelled as two separate signed CASH MOVEMENTS (see
 * `cashMovements` below) rather than by netting the refund into the payment's
 * own amount and day.
 *
 * A fully-refunded payment is flipped to `status = 'refunded'`
 * (lib/billing/refunds.ts); a partial refund leaves the payment `captured` at
 * its full amount. Either way the money DID come in on the payment's day, so
 * BOTH states count as money in — `p.status in ('captured','refunded')` — and
 * the refund row is what takes it back out, on its own day. Summing only
 * `captured` (the earlier rule) silently erased a fully-refunded sale from the
 * day it was made, and never subtracted a partial refund at all.
 *
 * Pending and failed tenders never reached the till and are not money in.
 *
 * ── VOIDS ───────────────────────────────────────────────────────────────────
 *
 * A VOID invoice contributes nothing — neither its payments nor their refunds
 * — even if money moved against it. Voiding is how a sale is struck off, and
 * lib/billing/refunds.ts requires the money to be refunded first anyway, so
 * the money-in and money-out cancel and dropping both is correct.
 *
 * ── STORED VALUE: WHY A WALLET TOP-UP IS NOT A SALE ─────────────────────────
 *
 * Selling wallet credit takes cash, but it is a deposit, not a sale — the
 * customer is owed goods. Counting the top-up AND the later spend would count
 * the same rupee twice. So:
 *
 *   * invoices whose items are a wallet TOP-UP are excluded entirely (both the
 *     top-up payment and any refund of it);
 *   * a wallet TENDER against a real bill is included, because that is the
 *     moment the deposit becomes a sale.
 *
 * ── ALLOCATING ONE MOVEMENT ACROSS REVENUE SOURCES ─────────────────────────
 *
 * A payment (or a refund) settles an invoice, not a line, so a bill holding
 * both a ₹75 booking and ₹120 of food has to be split. Each LINE is first
 * reduced to what it actually contributed to the bill, rebuilding priceBill()'s
 * own arithmetic from the frozen columns:
 *
 *     owed(line) = (line_total − line's pro-rata share of the discount)
 *                  × (1 + its own tax_rate/100)
 *
 * — discount pro rata by line value, tax at the LINE's OWN rate. The service
 * charge is the one exception: it is added AFTER the discount (it is never
 * discounted, see lib/billing/pricing.ts), and it is not part of the invoice
 * `subtotal`, so it takes NO share of the discount here — otherwise the
 * discount would be spread over a base larger than the one it was computed on
 * and every other line would be under-credited.
 *
 * Those owed amounts sum EXACTLY to the invoice total (subtotal − discount +
 * tax + service charge), so apportioning a movement by each kind's share of
 * them splits the money exactly: the parts add back to the movement, and no
 * rupee is counted under two sources. `adjustment` lines (a split bill's
 * shared-pool shares, lib/billing/split.ts) are pooled food/booking value and
 * are counted with food, the only place they occur being a restaurant table
 * split.
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
 * A `service_charge` line takes no discount share: the charge is levied after
 * the discount and sits outside `inv.subtotal`, so apportioning discount to it
 * would over-spread the discount and drag every other line's owed value below
 * what was actually charged.
 *
 * Requires `ii` (invoice_items) and `inv` (invoices) in scope.
 */
export const lineOwed: SQL = sql`((ii.line_total - case when ii.kind = 'service_charge' then 0 else inv.discount * ii.line_total / nullif(inv.subtotal, 0) end) * (1 + ii.tax_rate / 100))`

/**
 * What each invoice's lines are OWED, split by kind — the shares a movement is
 * apportioned by. `all_lines` equals the invoice total exactly, so the kind
 * shares partition a movement with no remainder.
 *
 * `topup_lines` is carried so the caller can drop deposit invoices entirely;
 * stored value is never revenue. `adjustment` is folded into food (see the
 * header): it is a split bill's pooled-share line, which is food.
 */
const invoiceKindShares: SQL = sql`
  select ii.invoice_id,
         coalesce(sum(owed) filter (where kind = 'booking'), 0)               as booking_lines,
         coalesce(sum(owed) filter (where kind in ('food','adjustment')), 0)  as food_lines,
         coalesce(sum(owed) filter (where kind = 'membership'), 0)            as membership_lines,
         coalesce(sum(owed) filter (where kind = 'service_charge'), 0)        as service_charge_lines,
         coalesce(sum(owed) filter (where kind = 'wallet_topup'), 0)          as topup_lines,
         coalesce(sum(owed), 0)                                               as all_lines
    from (
      select ii.invoice_id, ii.kind, ${lineOwed} as owed
        from public.invoice_items ii
        join public.invoices inv on inv.id = ii.invoice_id
    ) ii
   group by ii.invoice_id
`

/**
 * The signed CASH MOVEMENTS for one tenant and one inclusive local-date range:
 * every captured/refunded payment as a positive amount on its capture day, and
 * every refund as a negative amount on its refund day — each carrying its
 * invoice's frozen figures and per-kind owed shares so a caller can aggregate
 * gross / discount / tax / service charge / per-kind without re-joining.
 *
 * Returns a parenthesised sub-select; a caller writes `from ${cashMovements(…)} m`.
 *
 * The identity `m.subtotal − m.discount + m.tax_total + m.service_charge =
 * m.total` holds per row, so scaling each of those by `m.amount / m.total`
 * (a payment's collection ratio, negative for a refund) and summing gives
 * `net = gross − discount + tax + serviceCharge` exactly, refunds included.
 */
export function cashMovements(
  tenantId: string,
  range: { start: string; end: string },
  branchId?: string | null,
): SQL {
  const branchFilter = branchId ? sql`and i.branch_id = ${branchId}` : sql``
  const paymentLocalDay = sql`((p.created_at at time zone coalesce(b.timezone, t.timezone))::date)`
  const refundLocalDay = sql`((r.created_at at time zone coalesce(b.timezone, t.timezone))::date)`
  return sql`(
    select
      p.amount::numeric                       as amount,
      i.id                                    as invoice_id,
      i.branch_id                             as branch_id,
      b.name                                  as branch_name,
      i.subtotal                              as subtotal,
      i.discount                              as discount,
      i.tax_total                             as tax_total,
      i.service_charge_amount                 as service_charge,
      i.total                                 as total,
      ${paymentLocalDay}                      as local_day,
      coalesce(k.booking_lines, 0)            as booking_lines,
      coalesce(k.food_lines, 0)               as food_lines,
      coalesce(k.membership_lines, 0)         as membership_lines,
      coalesce(k.service_charge_lines, 0)     as service_charge_lines,
      coalesce(k.all_lines, 0)                as all_lines
    from public.payments p
    join public.invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id
    join public.branches b on b.id = i.branch_id
    join public.tenants  t on t.id = i.tenant_id
    left join (${invoiceKindShares}) k on k.invoice_id = i.id
    where p.tenant_id = ${tenantId}
      and p.status in ('captured', 'refunded')
      and i.status <> 'void'
      and coalesce(k.topup_lines, 0) = 0
      and ${paymentLocalDay} between ${range.start}::date and ${range.end}::date
      ${branchFilter}

    union all

    select
      (- r.amount)::numeric                   as amount,
      i.id                                    as invoice_id,
      i.branch_id                             as branch_id,
      b.name                                  as branch_name,
      i.subtotal                              as subtotal,
      i.discount                              as discount,
      i.tax_total                             as tax_total,
      i.service_charge_amount                 as service_charge,
      i.total                                 as total,
      ${refundLocalDay}                       as local_day,
      coalesce(k.booking_lines, 0)            as booking_lines,
      coalesce(k.food_lines, 0)               as food_lines,
      coalesce(k.membership_lines, 0)         as membership_lines,
      coalesce(k.service_charge_lines, 0)     as service_charge_lines,
      coalesce(k.all_lines, 0)                as all_lines
    from public.refunds r
    join public.payments p on p.id = r.payment_id and p.tenant_id = r.tenant_id
    join public.invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id
    join public.branches b on b.id = i.branch_id
    join public.tenants  t on t.id = i.tenant_id
    left join (${invoiceKindShares}) k on k.invoice_id = i.id
    where r.tenant_id = ${tenantId}
      and i.status <> 'void'
      and coalesce(k.topup_lines, 0) = 0
      and ${refundLocalDay} between ${range.start}::date and ${range.end}::date
      ${branchFilter}
  )`
}

/** The collected share of an invoice figure carried on a movement `m`: its
 *  stored column scaled by this movement's amount over the invoice total.
 *  Negative for a refund, so refunds reduce gross/discount/tax in proportion. */
export function movementShareOf(column: SQL): SQL {
  return sql`(m.${column} * m.amount / nullif(m.total, 0))`
}

/** How much of one movement belongs to `kind`, by that kind's share of the
 *  invoice's owed lines. Negative for a refund. */
export function movementForKind(kind: 'booking' | 'food' | 'membership' | 'service_charge'): SQL {
  const column =
    kind === 'booking'
      ? sql`booking_lines`
      : kind === 'food'
        ? sql`food_lines`
        : kind === 'membership'
          ? sql`membership_lines`
          : sql`service_charge_lines`
  return sql`(m.amount * m.${column} / nullif(m.all_lines, 0))`
}

/** Gross refunds (money returned) in the movement set — the positive size of
 *  the negative movements, for display alongside net. */
export const movementRefundsOut: SQL = sql`(case when m.amount < 0 then -m.amount else 0 end)`
