/**
 * Issuing an invoice for a booking — the transactional core of the POS bill.
 *
 * Takes a `tx` rather than opening its own, exactly like lib/customers/service.ts:
 * the caller (a server action, or a test script) supplies an RLS-scoped
 * transaction via withUser(), and everything here — the booking lock, the
 * duplicate-bill check, the sequence bump, the invoice and its items — commits
 * or rolls back together.
 *
 * Nothing in here trusts the browser. The caller passes a booking id and an
 * optional discount; every price, quantity, tax rate and total is re-read from
 * the database and recomputed through priceBill().
 */
import { and, eq, ne } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { bookings, bookingSlots, invoices, invoiceItems, orders, orderItems } from '@/db/schema'
import { durationHours } from '@/lib/booking/availability'
import { todayInZone } from '@/lib/booking/time'
import { timeInZone } from '@/lib/format'
import {
  applyPaidDepositsToInvoice,
  backfillDepositOrderIds,
  type DepositCarryResult,
} from '@/lib/payments/deposit-settlement'
import { cancelPendingOrdersForBilledBooking } from '@/lib/orders/service'
import { loadInvoicePrefix } from '@/lib/settings/business-profile'
import { resolveMembershipBenefit, type AppliedMembershipBenefit } from './membership-benefit'
import {
  commitRedemption,
  loadLoyaltyRule,
  lockedLoyaltyBalance,
  priceRedemption,
  type RedeemedLoyalty,
} from './loyalty'
import { paise } from './payments'
import { priceBill, round2, type BillLine, type PricingResult } from './pricing'
import { consumePromoUse, normalizePromoCode, validatePromo } from './promo'

type Db = NodePgDatabase<typeof schema>

/** Billing rule violations the cashier should see verbatim. */
export class BillingError extends Error {}

/**
 * Booking states a bill may be raised for — "confirmed/checked-in" from the
 * ticket, mapped onto the live `booking_status` enum (migration 0003). A
 * completed booking has already been through the till; cancelled and no_show
 * never owe anything.
 */
export const BILLABLE_BOOKING_STATUSES = ['confirmed', 'checked_in'] as const

export function isBillableBookingStatus(status: string): boolean {
  return (BILLABLE_BOOKING_STATUSES as readonly string[]).includes(status)
}

/**
 * Invoice number prefix. The tenant's own prefix comes from
 * `business_profiles.invoice_prefix` (migration 0012); this is the fallback for
 * a tenant that has not configured a profile. Re-exported so callers and tests
 * have one import site.
 */
export { DEFAULT_INVOICE_PREFIX } from '@/lib/settings/business-profile'

/** Digits in the running number, e.g. 123 → '…/000123'. */
const NUMBER_WIDTH = 6

/**
 * A GST invoice number may not exceed 16 characters.
 *
 * Budget with the format below: prefix + 1 + 4 (financial year) + 1 + 6 = 12 +
 * prefix, so the prefix must stay at 4 characters or fewer. 'INV' gives a
 * 15-character number. When AROS-31 lets a tenant choose its own prefix, that
 * ticket must validate the length against this.
 */
export const GST_INVOICE_NUMBER_MAX_LENGTH = 16

/**
 * The numbering scope. GST requires invoice numbers to run uniquely within a
 * financial year, and the Indian financial year runs 1 April → 31 March, so a
 * bill raised on 2026-08-10 belongs to period '2026-27'. Derived from the
 * TENANT's timezone, never the server's, via the existing todayInZone().
 */
export function financialYearPeriod(dateStr: string): string {
  const [year, month] = dateStr.split('-').map(Number)
  const startYear = month >= 4 ? year : year - 1
  return `${startYear}-${String(startYear + 1).slice(2)}`
}

/**
 * Build the invoice number: `INV/2627/000001`.
 *
 * THE FINANCIAL YEAR IS PART OF THE NUMBER, and that is not decoration. The
 * counter in `sequences` is keyed by (tenant, 'invoice', period), so it restarts
 * at 1 every 1 April — while `unique (tenant_id, invoice_number)` on `invoices`
 * spans the tenant's whole history. Without the year in the string, the first
 * bill of a new financial year would format the same text as the first bill of
 * the previous one and be rejected by that constraint; because the counter bump
 * and the insert share one transaction, the rollback would also undo the bump,
 * so every retry would reproduce it and billing would stay broken. Numbering
 * per financial year is also what GST expects.
 *
 * The year is compacted ('2026-27' → '2627') to stay inside the 16-character
 * limit above.
 */
export function formatInvoiceNumber(prefix: string, period: string, value: number): string {
  const fy = period.replace(/\D/g, '').slice(-4)
  return `${prefix}/${fy}/${String(value).padStart(NUMBER_WIDTH, '0')}`
}

/**
 * The booking's own charges, as priceBill lines.
 *
 * Read from `booking_slots`, which already snapshots what was agreed when the
 * booking was taken: `rate_applied`, `resource_name`, `resource_type_name`. We
 * bill from that snapshot rather than today's `resource_types.hourly_rate`, so a
 * price rise tomorrow cannot silently re-price a booking taken today — and it
 * keeps this identical to how lib/actions/bookings.ts priced the slot in the
 * first place (rate × durationHours), so the bill always agrees with the booking.
 *
 * Only ACTIVE slots are billed: the 0003 trigger clears `active` when a booking
 * is cancelled or marked no-show, so a released slot never reaches the till.
 */
export async function loadBookingLines(
  tx: Db,
  tenantId: string,
  bookingId: string,
  timeZone: string,
): Promise<BillLine[]> {
  const slots = await tx
    .select({
      id: bookingSlots.id,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
      rateApplied: bookingSlots.rateApplied,
      resourceName: bookingSlots.resourceName,
      resourceTypeName: bookingSlots.resourceTypeName,
    })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        eq(bookingSlots.bookingId, bookingId),
        eq(bookingSlots.active, true),
      ),
    )
    .orderBy(bookingSlots.startsAt)

  return slots.map((s) => ({
    description: `${s.resourceName} · ${timeInZone(s.startsAt, timeZone)}–${timeInZone(s.endsAt, timeZone)}`,
    kind: 'booking' as const,
    sourceId: s.id,
    qty: durationHours(s.startsAt, s.endsAt),
    unitPrice: Number(s.rateApplied),
    // No tax rate source exists yet: `tax_rates` is unbuilt (docs/DATA-MODEL.md
    // "M1 — Settings") and `resource_types` carries no tax column, so there is
    // nothing to read a percentage from. 0 keeps the arithmetic honest instead
    // of inventing a rate. Once tax_rates lands, resolve it here — priceBill
    // already does the whole multi-rate CGST/SGST split.
    taxPercent: 0,
  }))
}

/**
 * The booking's food & beverage charges, as priceBill lines.
 *
 * Only `open` orders count: `billed` means a previous invoice already charged
 * for them (see the status flip at the end of issueInvoiceForBooking below),
 * and `cancelled` orders were never served. Reading `status = 'open'` here is
 * what makes double-billing structurally impossible — once an order is
 * flipped to `billed` it stops appearing in every future bill for this
 * booking, this function included.
 *
 * Also gated on `acceptanceStatus = 'accepted'`: an online order still
 * `pending` in the accept/reject queue (lib/orders/data.ts's
 * listIncomingOnlineOrders) is `status = 'open'` too, same as an accepted
 * one — nothing else distinguishes them — so without this a booking billed
 * while an order sat unreviewed would charge the customer for food the
 * kitchen was never told to make. A staff-placed order always has
 * `acceptanceStatus = 'accepted'` (see createOrderCore's default), so this
 * never excludes anything from the POS flow.
 *
 * unit_price and tax_rate are read straight off order_items, unchanged: they
 * were already snapshotted at order time (including any happy-hour discount),
 * so this never re-prices a menu item against today's rate.
 */
export async function loadFoodLines(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<BillLine[]> {
  const rows = await tx
    .select({
      id: orderItems.id,
      itemName: orderItems.itemName,
      unitPrice: orderItems.unitPrice,
      taxRate: orderItems.taxRate,
      qty: orderItems.qty,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.bookingId, bookingId),
        eq(orders.status, 'open'),
        eq(orders.acceptanceStatus, 'accepted'),
      ),
    )
    .orderBy(orderItems.id)

  return rows.map((r) => ({
    description: r.itemName,
    kind: 'food' as const,
    sourceId: r.id,
    qty: r.qty,
    unitPrice: Number(r.unitPrice),
    taxPercent: Number(r.taxRate),
  }))
}

/**
 * One standalone order's own lines, as priceBill lines — no booking/
 * acceptanceStatus filter, unlike loadFoodLines: this is read once, at the
 * single moment a pay-now order is being priced or invoiced (order-payment.ts
 * for the gateway amount, issueInvoiceForOrder below for the bill), never as
 * a repeatable "what's still owed" query the way loadFoodLines is. The
 * caller is responsible for having already locked and validated the order's
 * state before calling this.
 *
 * unit_price and tax_rate are read straight off order_items, unchanged — the
 * same snapshot discipline loadFoodLines follows.
 */
export async function loadOrderFoodLines(
  tx: Db,
  tenantId: string,
  orderId: string,
): Promise<BillLine[]> {
  // Pins order_items_public_select (migration 0060) to this one order — a
  // no-op under the owner-role connection issueInvoiceForOrder below runs on
  // (RLS-exempt), and redundant-but-harmless when the caller (order-payment.ts)
  // already set the same value via loadPayableOrder moments earlier.
  await tx.execute(sql`select set_config('app.public_order_id', ${orderId}, true)`)
  const rows = await tx
    .select({
      id: orderItems.id,
      itemName: orderItems.itemName,
      unitPrice: orderItems.unitPrice,
      taxRate: orderItems.taxRate,
      qty: orderItems.qty,
    })
    .from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)))
    .orderBy(orderItems.id)

  return rows.map((r) => ({
    description: r.itemName,
    kind: 'food' as const,
    sourceId: r.id,
    qty: r.qty,
    unitPrice: Number(r.unitPrice),
    taxPercent: Number(r.taxRate),
  }))
}

/**
 * Every billable line for a booking: its time charges plus any food &
 * beverage ordered against it. One booking, one bill — the rest of the
 * pipeline (priceBill, invoice_items, the bill screen's sections) already
 * handles a mix of `kind: 'booking'` and `kind: 'food'` lines with no further
 * change.
 */
export async function loadBillLines(
  tx: Db,
  tenantId: string,
  bookingId: string,
  timeZone: string,
): Promise<BillLine[]> {
  // Sequential, not Promise.all: both share ONE transaction client, and a
  // Postgres connection cannot run two queries at once (see lib/billing/receipt.ts).
  const bookingLines = await loadBookingLines(tx, tenantId, bookingId, timeZone)
  const foodLines = await loadFoodLines(tx, tenantId, bookingId)
  return [...bookingLines, ...foodLines]
}

/**
 * A live invoice's own line items, read back as BillLine — the frozen
 * snapshot, not a recomputation.
 *
 * Once a booking is billed, its food orders flip to `status='billed'` (see
 * step 7 of issueInvoiceForBooking) precisely so loadFoodLines stops
 * returning them — that is what makes double-billing impossible. But it also
 * means loadBillLines() can no longer be used to DISPLAY an already-issued
 * bill: it would silently drop the food lines from the screen the moment
 * they're billed, even though the invoice itself still charges for them. Any
 * caller showing an EXISTING invoice (the bill screen once it has one, a
 * reprint, …) must read the lines from here instead.
 */
export async function loadInvoiceLines(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<BillLine[]> {
  const rows = await tx
    .select({
      description: invoiceItems.description,
      kind: invoiceItems.kind,
      sourceId: invoiceItems.sourceId,
      qty: invoiceItems.qty,
      unitPrice: invoiceItems.unitPrice,
      taxRate: invoiceItems.taxRate,
    })
    .from(invoiceItems)
    .where(and(eq(invoiceItems.tenantId, tenantId), eq(invoiceItems.invoiceId, invoiceId)))
    .orderBy(invoiceItems.createdAt)

  return rows.map((r) => ({
    description: r.description,
    kind: r.kind,
    sourceId: r.sourceId ?? undefined,
    qty: Number(r.qty),
    unitPrice: Number(r.unitPrice),
    taxPercent: Number(r.taxRate),
  }))
}

export type ExistingInvoice = { id: string; invoiceNumber: string; status: string }

/**
 * The booking's live invoice, if it has one. A voided invoice does not count —
 * voiding is how a mis-billed booking gets a second chance.
 */
export async function findLiveInvoice(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<ExistingInvoice | null> {
  const [row] = await tx
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.bookingId, bookingId),
        ne(invoices.status, 'void'),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Next invoice number for the tenant, atomically.
 *
 * ONE statement: the upsert takes a row lock on the (tenant, kind, period) key,
 * so two cashiers billing at the same instant queue on it and come out with
 * different numbers. A read-then-write would hand both the same number and the
 * unique (tenant_id, invoice_number) index would reject the loser.
 */
export async function nextInvoiceNumber(
  tx: Db,
  tenantId: string,
  period: string,
  prefix: string,
): Promise<string> {
  const bumped = await tx.execute<{ value: number }>(sql`
    insert into sequences (tenant_id, kind, period, value)
    values (${tenantId}, 'invoice', ${period}, 1)
    on conflict (tenant_id, kind, period)
      do update set value = sequences.value + 1
    returning value
  `)
  const value = Number(bumped.rows[0].value)
  return formatInvoiceNumber(prefix, period, value)
}

export type IssueInvoiceInput = {
  bookingId: string
  discount?: number
  promoCode?: string
  /**
   * Loyalty points the customer wants to spend on this bill. Only a COUNT
   * travels from the client — the rupee value, the cap and the debit are all
   * decided server-side from the tenant's rule and the ledger balance.
   */
  redeemPoints?: number
}

export type IssuedInvoice = {
  invoiceId: string
  invoiceNumber: string
  pricing: PricingResult
  /**
   * The membership benefit applied, if any (AROS-61). Null when the customer
   * had no eligible membership, or its snapshot carried no discount.
   */
  membership: AppliedMembershipBenefit | null
  /** Loyalty points actually spent on this bill. Null when none were. */
  loyalty: RedeemedLoyalty | null
  /**
   * Online deposits carried onto this invoice as captured payments when it was
   * raised (AROS-51). The balance the till shows already accounts for them —
   * this is here so the caller can say "₹200 deposit applied", and so an
   * `unapplied` entry (a deposit bigger than the bill) is visible rather than
   * silently dropped.
   */
  deposits: DepositCarryResult
}

/**
 * Raise the invoice for a booking. Everything below runs in the caller's
 * transaction, so a failure at any step leaves no invoice, no items and no
 * consumed sequence number.
 */
export async function issueInvoiceForBooking(
  tx: Db,
  tenant: { id: string; timezone: string },
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  // ── 1. lock the booking ───────────────────────────────────────────────────
  // SELECT … FOR UPDATE is what makes double-billing impossible: a second
  // cashier's transaction blocks here until the first commits, and then sees the
  // invoice it wrote. RLS applies to this read, so another tenant's booking id
  // simply returns no row.
  const [booking] = await tx
    .select({
      id: bookings.id,
      bookingNumber: bookings.bookingNumber,
      branchId: bookings.branchId,
      customerId: bookings.customerId,
      status: bookings.status,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, tenant.id)))
    .for('update')
    .limit(1)

  if (!booking) throw new BillingError('Booking not found.')

  if (!isBillableBookingStatus(booking.status)) {
    throw new BillingError('This booking cannot be billed in its current status.')
  }

  // ── 2. already billed? ────────────────────────────────────────────────────
  const existing = await findLiveInvoice(tx, tenant.id, booking.id)
  if (existing) {
    throw new BillingError(`This booking has already been billed (${existing.invoiceNumber}).`)
  }

  // ── 3. lines, entirely from server-side data ──────────────────────────────
  const lines = await loadBillLines(tx, tenant.id, booking.id, tenant.timezone)
  if (lines.length === 0) {
    throw new BillingError('This booking has nothing to bill.')
  }

  // ── 4. discounts ──────────────────────────────────────────────────────────
  // Precedence — the single authoritative statement of it lives in
  // lib/billing/membership-benefit.ts:
  //
  //   1. Base line pricing (happy hours would sit here; not yet wired in)
  //   2. MEMBERSHIP benefit — % of subtotal, from the purchased snapshot
  //   3. PROMO CODE or a keyed-in discount — against what REMAINS after (2)
  //
  // All of it is subtracted BEFORE GST: the combined figure goes to priceBill()
  // as one `discount`, which caps it at the subtotal and allocates it across
  // tax rates pro-rata. Nothing below recomputes tax.
  //
  // The subtotal has to exist before any percentage can be priced. Pricing with
  // no discount gives it — priceBill is pure, so calling it twice costs nothing
  // and keeps it the only thing in the codebase that adds up a bill.
  const gross = priceBill({ lines })

  // ── 4a. membership ────────────────────────────────────────────────────────
  // THE authoritative application, and the only one: getBillableForBooking()
  // resolves the same benefit but merely displays it. The customer comes off
  // the BOOKING row read under RLS above, never from the caller, so a client
  // cannot nominate another customer's membership. Every figure comes from the
  // customer_memberships snapshot — membership_plans is not read.
  const membership = await resolveMembershipBenefit(
    tx,
    tenant.id,
    booking.customerId,
    gross.subtotal,
  )
  const membershipDiscount = membership?.discountAmount ?? 0

  // What a promo or a keyed-in discount may still take off. A membership that
  // covers the whole bill leaves nothing for either.
  const afterMembership = round2(gross.subtotal - membershipDiscount)

  const promoCode = normalizePromoCode(input.promoCode)
  let promoId: string | null = null
  // A keyed-in discount is capped at the remainder for the same reason a promo
  // is: the two discounts together must never exceed the bill.
  let discount = Math.min(round2(input.discount ?? 0), afterMembership)

  if (promoCode) {
    const promo = await validatePromo(tx, tenant.id, promoCode, afterMembership)
    // An invalid code stops the bill. Billing anyway at full price would
    // silently overcharge a customer who was promised the discount.
    if (!promo.ok) throw new BillingError(promo.reason)
    // The promo replaces any manually typed discount rather than stacking with
    // it, so a code and a keyed-in figure can never compound into more off than
    // either was worth.
    promoId = promo.promoId
    discount = promo.discount
  }

  // ── 4c. loyalty redemption ────────────────────────────────────────────────
  // LAST in the precedence (see lib/billing/loyalty.ts). Points are stored
  // value, so they settle what is genuinely still owed rather than being burnt
  // against amounts a promo was about to remove. Capped at the remainder, and
  // only the points that funded the capped amount are debited.
  //
  // The customer row is locked BEFORE the balance is read, so two tills
  // redeeming at once serialise — the same device the wallet uses, and the same
  // customer→invoice lock order, so the two cannot deadlock.
  let loyalty: RedeemedLoyalty | null = null
  // A negative or fractional count is nonsense that should never arrive — the
  // action's Zod schema rejects it — but this core is reachable from anywhere a
  // `tx` is, so it refuses rather than silently ignoring. 0 and undefined mean
  // "no redemption" and bill normally.
  if (input.redeemPoints !== undefined && input.redeemPoints !== 0) {
    if (!Number.isInteger(input.redeemPoints) || input.redeemPoints < 0) {
      throw new BillingError('Points to redeem must be a whole number of zero or more.')
    }
  }
  if (input.redeemPoints && input.redeemPoints > 0) {
    if (!booking.customerId) {
      throw new BillingError('This booking has no customer, so points cannot be redeemed.')
    }
    const rule = await loadLoyaltyRule(tx, tenant.id)
    await lockedLoyaltyBalance(tx, tenant.id, booking.customerId)

    const remainingAfterOthers = round2(gross.subtotal - membershipDiscount - discount)
    loyalty = await priceRedemption(
      tx,
      tenant.id,
      booking.customerId,
      input.redeemPoints,
      remainingAfterOthers,
      rule,
    )
  }
  const loyaltyDiscount = loyalty?.discount ?? 0

  // The combined figure. Membership + (promo | keyed-in) + loyalty — capped once
  // more at the subtotal so no combination can drive the bill negative, belt and
  // braces with priceBill's own cap.
  const totalDiscount = Math.min(
    round2(membershipDiscount + discount + loyaltyDiscount),
    gross.subtotal,
  )

  // priceBill owns every rupee: line rounding, discount-before-GST, the
  // per-rate CGST/SGST split and the total. Nothing is recomputed here.
  const pricing = priceBill({ lines, discount: totalDiscount })

  // Take the use only now, with the bill certain to be written. It is one
  // statement and it re-checks the limit under a row lock, so the last use of a
  // limited promo can go to only one of two simultaneous cashiers. Everything
  // from here shares this transaction: if the invoice or its items fail, the
  // rollback returns the use too.
  if (promoId) {
    const consumed = await consumePromoUse(tx, tenant.id, promoId)
    if (!consumed) throw new BillingError('Promo code usage limit reached.')
  }

  // ── 5. number + invoice ───────────────────────────────────────────────────
  const period = financialYearPeriod(todayInZone(tenant.timezone))
  // The tenant's configured prefix (settings → Business profile), read inside
  // this transaction so a prefix change cannot interleave with a bill.
  const prefix = await loadInvoicePrefix(tx, tenant.id)
  const invoiceNumber = await nextInvoiceNumber(tx, tenant.id, period, prefix)

  // A bill for nothing (every line free, or a discount that clears the lot) owes
  // nothing, so it is settled the moment it is raised. Without this the row
  // would sit at 'issued' forever while the receipt — which derives its PAID
  // badge from total-minus-captured — printed PAID, and the two would disagree.
  // Any non-zero total still starts at 'issued'.
  const settledOnIssue = paise(pricing.total) === 0

  const [invoice] = await tx
    .insert(invoices)
    .values({
      tenantId: tenant.id,
      branchId: booking.branchId,
      invoiceNumber,
      bookingId: booking.id,
      customerId: booking.customerId,
      // Which promo was actually honoured, not just the amount it took off.
      promoCodeId: promoId,
      // The membership half of `discount`, frozen at issue (migration 0027) so
      // the bill stays explicable after the membership expires or the plan is
      // repriced. Never recomputed, and never read back from the live plan.
      customerMembershipId: membership?.membershipId ?? null,
      membershipDiscount: membershipDiscount.toFixed(2),
      membershipDiscountPercent: (membership?.discountPercent ?? 0).toFixed(2),
      membershipPlanName: membership?.planName ?? null,
      // The loyalty half of `discount`, frozen at issue with the rate honoured
      // (migration 0029), so a reprint never consults today's loyalty_settings.
      loyaltyPointsRedeemed: loyalty?.points ?? 0,
      loyaltyDiscount: loyaltyDiscount.toFixed(2),
      loyaltyPointValue: (loyalty?.pointValue ?? 0).toFixed(2),
      subtotal: pricing.subtotal.toFixed(2),
      discount: pricing.discount.toFixed(2),
      taxTotal: pricing.taxTotal.toFixed(2),
      // Mapped straight from priceBill onto the stored TaxBreakupLine shape —
      // `percent` is the column's `rate`. No `taxable`: see TaxBreakupLine.
      taxBreakup: pricing.taxBreakup.map((g) => ({
        rate: g.percent,
        cgst: g.cgst.toFixed(2),
        sgst: g.sgst.toFixed(2),
      })),
      total: pricing.total.toFixed(2),
      status: settledOnIssue ? 'paid' : 'issued',
      issuedAt: new Date(),
    })
    .returning({ id: invoices.id })

  // ── 6. items — the historical snapshot ────────────────────────────────────
  // Every number the invoice was built from is frozen onto the row, so a later
  // price change can never move a past bill.
  await tx.insert(invoiceItems).values(
    pricing.items.map((item) => ({
      tenantId: tenant.id,
      invoiceId: invoice.id,
      kind: item.kind,
      sourceId: item.sourceId ?? null,
      description: item.description,
      qty: item.qty.toFixed(2),
      unitPrice: item.unitPrice.toFixed(2),
      taxRate: item.taxPercent.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
    })),
  )

  // ── 7. mark the food orders billed ────────────────────────────────────────
  // The other half of double-billing prevention: loadFoodLines only reads
  // status='open', acceptanceStatus='accepted' orders, so flipping THE SAME
  // set to 'billed' here — in the same transaction as the invoice itself —
  // means the same fries can never end up on a second bill, and a failure
  // anywhere above rolls this back too. The acceptanceStatus condition must
  // stay identical to loadFoodLines': otherwise a still-pending order (not on
  // this invoice) would get marked 'billed' anyway and vanish from both the
  // accept/reject queue and every future bill without ever having been paid
  // for.
  await tx
    .update(orders)
    .set({ status: 'billed' })
    .where(
      and(
        eq(orders.tenantId, tenant.id),
        eq(orders.bookingId, booking.id),
        eq(orders.status, 'open'),
        eq(orders.acceptanceStatus, 'accepted'),
      ),
    )

  // ── 7b. void anything still unreviewed ────────────────────────────────────
  // The other side of the same gap: an order that was still `pending` when
  // this bill was raised was excluded above (see loadFoodLines' comment) and
  // just skipped the 'billed' flip too — left `open`/`pending` forever. Left
  // alone, staff could later accept it from /orders/incoming and the kitchen
  // would serve food against an invoice that already closed. Reject it here,
  // in the same transaction as the invoice, so it can never become billable
  // again — see cancelPendingOrdersForBilledBooking's own comment.
  await cancelPendingOrdersForBilledBooking(tx, { tenantId: tenant.id }, booking.id)

  // ── 8. carry over any deposit already paid online ─────────────────────────
  // The usual order is deposit first, bill later, so this is where the money
  // the venue already holds becomes a captured payment against the invoice.
  // From here on the M1 balance — total minus captured — is simply correct, and
  // nothing downstream needs to know a deposit was involved.
  //
  // Inside the same transaction as the invoice and its items: a bill can never
  // be raised showing a deposit that was not actually recorded, or the reverse.
  // recordVerifiedGatewayPayment() flips the invoice to 'paid' if the deposit
  // covers the whole total, exactly as a cashier's final tender would.
  // Debit the points now the invoice exists to reference. Same transaction, so
  // a discounted bill can never exist without its debit, nor a debit without
  // the bill it funded. Idempotent per invoice via the unique ledger index.
  if (loyalty && booking.customerId) {
    await commitRedemption(tx, tenant.id, booking.customerId, invoice.id, loyalty)
  }

  const deposits = await applyPaidDepositsToInvoice(tx, tenant.id, booking.id, invoice.id)
  if (deposits.applied.length > 0) {
    await backfillDepositOrderIds(tx, tenant.id, invoice.id)
  }

  return { invoiceId: invoice.id, invoiceNumber, pricing, membership, loyalty, deposits }
}

/**
 * Raise the invoice for a MEMBERSHIP sale (AROS-60).
 *
 * Sibling to issueInvoiceForBooking() above, sharing every piece that decides
 * money: priceBill() owns the arithmetic, nextInvoiceNumber() owns the GST
 * sequence, loadInvoicePrefix() owns the prefix, financialYearPeriod() owns the
 * scope. Only the LINES differ — one `membership` line instead of booking slots
 * and food — so a membership bill is numbered, taxed and totalled exactly like
 * any other bill in the system.
 *
 * ── Tax ─────────────────────────────────────────────────────────────────────
 * `membership_plans` carries no tax rate (AROS-59), so the line is raised at 0%
 * and the plan price IS the invoice total. That is deliberate: inventing a GST
 * rate the venue never configured would put a wrong number on a legal document.
 * When plans gain a `tax_rate_id`, pass its percent through `taxPercent` and
 * nothing else here changes.
 *
 * ── Branch ──────────────────────────────────────────────────────────────────
 * `invoices.branch_id` is NOT NULL but a membership is not branch-scoped, so
 * the caller supplies the selling member's branch, falling back to the tenant's
 * primary branch.
 *
 * Runs in the caller's transaction: the invoice, its item, the membership row
 * and the tender all commit or roll back together.
 */
export async function issueMembershipInvoice(
  tx: Db,
  tenant: { id: string; timezone: string },
  input: {
    branchId: string
    customerId: string
    /** Snapshotted plan name, for the line description. */
    planName: string
    /** Rupees — the snapshotted price the customer is being charged. */
    price: number
    /** The customer_membership this bill is for, kept on the line as source. */
    membershipId: string
  },
): Promise<IssuedInvoice> {
  const lines: BillLine[] = [
    {
      kind: 'membership',
      description: `${input.planName} membership`,
      sourceId: input.membershipId,
      qty: 1,
      unitPrice: input.price,
      // See the tax note above.
      taxPercent: 0,
    },
  ]

  const pricing = priceBill({ lines })

  const period = financialYearPeriod(todayInZone(tenant.timezone))
  const prefix = await loadInvoicePrefix(tx, tenant.id)
  const invoiceNumber = await nextInvoiceNumber(tx, tenant.id, period, prefix)

  // A comped (₹0) membership owes nothing, so it is settled the moment it is
  // raised — the same rule issueInvoiceForBooking() applies to a free bill.
  const settledOnIssue = paise(pricing.total) === 0

  const [invoice] = await tx
    .insert(invoices)
    .values({
      tenantId: tenant.id,
      branchId: input.branchId,
      invoiceNumber,
      // No booking: a membership is sold on its own.
      bookingId: null,
      customerId: input.customerId,
      subtotal: pricing.subtotal.toFixed(2),
      discount: pricing.discount.toFixed(2),
      taxTotal: pricing.taxTotal.toFixed(2),
      taxBreakup: pricing.taxBreakup.map((g) => ({
        rate: g.percent,
        cgst: g.cgst.toFixed(2),
        sgst: g.sgst.toFixed(2),
      })),
      total: pricing.total.toFixed(2),
      status: settledOnIssue ? 'paid' : 'issued',
      issuedAt: new Date(),
    })
    .returning({ id: invoices.id })

  await tx.insert(invoiceItems).values(
    pricing.items.map((item) => ({
      tenantId: tenant.id,
      invoiceId: invoice.id,
      kind: item.kind,
      sourceId: item.sourceId ?? null,
      description: item.description,
      qty: item.qty.toFixed(2),
      unitPrice: item.unitPrice.toFixed(2),
      taxRate: item.taxPercent.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
    })),
  )

  // No deposit carry-over: a membership sale has no booking, so there is no
  // payment intent to attach.
  return {
    invoiceId: invoice.id,
    invoiceNumber,
    pricing,
    // Buying a membership is not itself discounted by one.
    membership: null,
    loyalty: null,
    deposits: { applied: [], unapplied: [] },
  }
}

/**
 * Raise the invoice for a WALLET TOP-UP.
 *
 * Third sibling of issueInvoiceForBooking() / issueMembershipInvoice(), sharing
 * every piece that decides money: priceBill() for the arithmetic,
 * nextInvoiceNumber() for the GST sequence, loadInvoicePrefix() for the prefix.
 * Only the line differs.
 *
 * ── What a top-up is, financially ───────────────────────────────────────────
 * Money received in advance, not revenue. The line is `kind='wallet_topup'` at
 * 0% tax (migration 0028): issuing wallet credit is not a supply under GST, and
 * the tax attaches later, when the credit is redeemed against a real booking or
 * food line. The customer pays face value and receives face value.
 *
 * No discount and no membership benefit is applied — discounting a top-up would
 * mean selling ₹1000 of spending power for less than ₹1000, which is a
 * different product decision and not one this ticket makes.
 */
export async function issueWalletTopUpInvoice(
  tx: Db,
  tenant: { id: string; timezone: string },
  input: { branchId: string; customerId: string; amount: number },
): Promise<IssuedInvoice> {
  const lines: BillLine[] = [
    {
      kind: 'wallet_topup',
      description: 'Wallet top-up',
      qty: 1,
      unitPrice: input.amount,
      // See the tax note above.
      taxPercent: 0,
    },
  ]

  const pricing = priceBill({ lines })

  const period = financialYearPeriod(todayInZone(tenant.timezone))
  const prefix = await loadInvoicePrefix(tx, tenant.id)
  const invoiceNumber = await nextInvoiceNumber(tx, tenant.id, period, prefix)

  const [invoice] = await tx
    .insert(invoices)
    .values({
      tenantId: tenant.id,
      branchId: input.branchId,
      invoiceNumber,
      bookingId: null,
      customerId: input.customerId,
      subtotal: pricing.subtotal.toFixed(2),
      discount: pricing.discount.toFixed(2),
      taxTotal: pricing.taxTotal.toFixed(2),
      taxBreakup: pricing.taxBreakup.map((g) => ({
        rate: g.percent,
        cgst: g.cgst.toFixed(2),
        sgst: g.sgst.toFixed(2),
      })),
      total: pricing.total.toFixed(2),
      // Always 'issued': a top-up must be TENDERED before the credit is
      // granted, and the caller settles it in this same transaction.
      status: 'issued',
      issuedAt: new Date(),
    })
    .returning({ id: invoices.id })

  await tx.insert(invoiceItems).values(
    pricing.items.map((item) => ({
      tenantId: tenant.id,
      invoiceId: invoice.id,
      kind: item.kind,
      sourceId: null,
      description: item.description,
      qty: item.qty.toFixed(2),
      unitPrice: item.unitPrice.toFixed(2),
      taxRate: item.taxPercent.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
    })),
  )

  return {
    invoiceId: invoice.id,
    invoiceNumber,
    pricing,
    // Buying wallet credit is neither discounted by a membership nor by points:
    // ₹1000 of spending power costs ₹1000.
    membership: null,
    loyalty: null,
    deposits: { applied: [], unapplied: [] },
  }
}

/**
 * Raise the invoice for a PAID STANDALONE ORDER (M14 #6, v2's pay-now).
 *
 * Fourth sibling of issueInvoiceForBooking() / issueMembershipInvoice() /
 * issueWalletTopUpInvoice(), sharing the same money infrastructure
 * (priceBill, nextInvoiceNumber, loadInvoicePrefix, financialYearPeriod).
 * Deliberately the simplest of the four: no promo code, no loyalty
 * redemption, no membership benefit — a prepaid order is charged at face
 * value, same scope decision issueWalletTopUpInvoice makes for a top-up.
 *
 * Called ONLY from lib/payments/webhook.ts, after a verified `payment.captured`
 * for an `order_payment` intent, inside that webhook's transaction — so the
 * invoice, its items and the flip of orders.status/acceptanceStatus (done by
 * the caller, not here) commit or roll back together with the payment
 * record `recordVerifiedGatewayPayment` writes right after this returns.
 *
 * Left at status 'issued', not short-circuited to 'paid': the caller settles
 * it via recordVerifiedGatewayPayment in the same transaction, exactly like
 * issueWalletTopUpInvoice leaves the transition to its own caller — one
 * place owns "when does an invoice become paid".
 */
export async function issueInvoiceForOrder(
  tx: Db,
  tenant: { id: string; timezone: string },
  order: { id: string; branchId: string; customerId: string | null; orderNumber: string },
): Promise<{ invoiceId: string; invoiceNumber: string; pricing: PricingResult }> {
  const lines = await loadOrderFoodLines(tx, tenant.id, order.id)
  if (lines.length === 0) {
    throw new BillingError('This order has nothing to bill.')
  }

  const pricing = priceBill({ lines })

  const period = financialYearPeriod(todayInZone(tenant.timezone))
  const prefix = await loadInvoicePrefix(tx, tenant.id)
  const invoiceNumber = await nextInvoiceNumber(tx, tenant.id, period, prefix)

  const [invoice] = await tx
    .insert(invoices)
    .values({
      tenantId: tenant.id,
      branchId: order.branchId,
      invoiceNumber,
      // No booking: this order was never attached to one — that's the whole
      // reason it went through pay-now instead of add-to-bill.
      bookingId: null,
      customerId: order.customerId,
      subtotal: pricing.subtotal.toFixed(2),
      discount: pricing.discount.toFixed(2),
      taxTotal: pricing.taxTotal.toFixed(2),
      taxBreakup: pricing.taxBreakup.map((g) => ({
        rate: g.percent,
        cgst: g.cgst.toFixed(2),
        sgst: g.sgst.toFixed(2),
      })),
      total: pricing.total.toFixed(2),
      status: 'issued',
      issuedAt: new Date(),
    })
    .returning({ id: invoices.id })

  await tx.insert(invoiceItems).values(
    pricing.items.map((item) => ({
      tenantId: tenant.id,
      invoiceId: invoice.id,
      kind: item.kind,
      sourceId: item.sourceId ?? null,
      description: item.description,
      qty: item.qty.toFixed(2),
      unitPrice: item.unitPrice.toFixed(2),
      taxRate: item.taxPercent.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
    })),
  )

  return { invoiceId: invoice.id, invoiceNumber, pricing }
}
