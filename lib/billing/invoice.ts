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
import { and, eq, inArray, ne } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookings, bookingSlots, invoices, invoiceItems, orders, orderItems } from '@/db/schema'
import { durationHours } from '@/lib/booking/availability'
import { todayInZone } from '@/lib/booking/time'
import { timeInZone } from '@/lib/format'
import {
  applyPaidDepositsToInvoice,
  backfillDepositOrderIds,
  type DepositCarryResult,
} from '@/lib/payments/deposit-settlement'
import { cancelPendingOrdersForBilledBooking } from '@/lib/orders/service'
import { loadInvoicePrefix, loadServiceChargeConfig } from '@/lib/settings/business-profile'
import { resolveMembershipBenefit, type AppliedMembershipBenefit } from './membership-benefit'
import {
  commitRedemption,
  loadLoyaltyRule,
  lockedLoyaltyBalance,
  priceRedemption,
  type RedeemedLoyalty,
} from './loyalty'
import { paise } from './payments'
import {
  computeServiceCharge,
  mergeTaxBreakup,
  priceBill,
  round2,
  type BillLine,
  type PricingResult,
  type ServiceChargeResult,
} from './pricing'
import { consumePromoUse, normalizePromoCode, validatePromo } from './promo'

type Db = NodePgDatabase<typeof schema>

/** Billing rule violations the cashier should see verbatim. */
export class BillingError extends Error {}

/**
 * Bill-level comp/discount audit trail (M18 #5).
 *
 * No shared audit module exists in this codebase (see lib/orders/service.ts's
 * writeAudit for the same note) — each domain keeps its own private copy.
 * Exported (unlike the others) because lib/billing/split.ts's split-bill
 * comp path is the same feature, same transaction shape, same table, and
 * genuinely the same domain — not a cross-cutting reuse.
 */
export type AuditActor = { tenantId: string; membershipId: string }

/** Append one durable, append-only row to `audit_log` for `entry`, attributed to `actor`. */
export async function writeAudit(
  tx: Db,
  actor: AuditActor,
  entry: {
    action: string
    entityType: string
    entityId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorMembershipId: actor.membershipId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  })
}

/**
 * Booking states a bill may be raised for — "confirmed/checked-in" from the
 * ticket, mapped onto the live `booking_status` enum (migration 0003). A
 * completed booking has already been through the till; cancelled and no_show
 * never owe anything.
 */
export const BILLABLE_BOOKING_STATUSES = ['confirmed', 'checked_in'] as const

/** True when a booking in `status` may have a bill raised against it (see BILLABLE_BOOKING_STATUSES above). */
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
 * price rise tomorrow cannot silently re-price a booking taken today — and for
 * a plain RESERVED booking, that keeps this identical to how the slot was
 * priced in the first place (rate × durationHours), so the bill always agrees
 * with the booking, down to the qty/unit-price decomposition a cashier sees
 * on screen (see scripts/test-billing-flow.ts's own assertion on this exact
 * shape).
 *
 * A walk-in (either mode) is the exception: checkoutWalkinCore (M21 #4 open
 * tab, M21 #5 timed) prices it with priceElapsedTime — a per-segment
 * happy-hour blend a flat rate×duration recomputation here cannot reproduce —
 * and writes the result onto `slot_total`. That one case bills as a single
 * qty=1 line at the already-priced total instead.
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
  const [booking] = await tx
    .select({ channel: bookings.channel, billingMode: bookings.billingMode })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1)
  const isWalkin = booking?.channel === 'walkin'
  // A timed walk-in's slot is born with a real ends_at (the committed end),
  // unlike an open tab's null-until-checkout — so "not yet checked out" for
  // one has to be read off slot_total still sitting at 0 instead. Safe
  // because a walk-in resource always has a nonzero rate
  // (listWalkinResources excludes zero-rate types), so a real session can
  // never legitimately price to exactly 0.
  const isUncommittedTimed = isWalkin && booking?.billingMode === 'timed'

  const slots = await tx
    .select({
      id: bookingSlots.id,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
      rateApplied: bookingSlots.rateApplied,
      slotTotal: bookingSlots.slotTotal,
      resourceName: bookingSlots.resourceName,
      resourceTypeName: bookingSlots.resourceTypeName,
      taxRatePercent: bookingSlots.taxRatePercent,
      // M21 per-head #2: snapshot of head_count/pricing_mode at booking time
      // (lib/booking/service.ts's priceBookingSlots). Null/'per_resource' for
      // every pre-existing booking.
      headCount: bookingSlots.headCount,
      pricingMode: bookingSlots.pricingMode,
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

  return slots
    .filter((s): s is typeof s & { endsAt: Date } => {
      // An open-tab walk-in slot has no ends_at until checkoutWalkinCore
      // finalizes it — nothing to bill yet.
      if (s.endsAt === null) return false
      // A timed walk-in's ends_at is set from the start, but it isn't
      // PRICED until checkout — this filter keeps a read-only bill preview
      // (lib/billing/data.ts) degrading gracefully rather than crashing.
      // It is NOT what stops the invoice-issuing path from silently billing
      // just the food and omitting the session charge — prepareBookingBill
      // rejects that case explicitly, before it ever reaches this filter.
      if (isUncommittedTimed && Number(s.slotTotal) === 0) return false
      return true
    })
    .map((s) => ({
      description: `${s.resourceName} · ${timeInZone(s.startsAt, timeZone)}–${timeInZone(s.endsAt, timeZone)}`,
      kind: 'booking' as const,
      sourceId: s.id,
      ...(isWalkin
        ? // qty=1, unitPrice=the whole priced total — same "one computed
          // charge" shape priceElapsedTime itself returns, rather than a
          // qty/rate pair that would need to multiply back to that figure.
          { qty: 1, unitPrice: Number(s.slotTotal) }
        : {
            // M21 per-head #2: rateApplied is per PLAYER for a per_head slot
            // (snapshotted pricingMode/headCount, priceBookingSlots), so the
            // multiplier folds into qty rather than unitPrice — reproduces
            // slot_total exactly (headCount × rate × hours) while leaving a
            // per_resource slot's qty/unit-price decomposition (hours × rate)
            // byte-identical to before this ticket.
            qty: durationHours(s.startsAt, s.endsAt) * (s.pricingMode === 'per_head' ? (s.headCount ?? 1) : 1),
            unitPrice: Number(s.rateApplied),
          }),
      // Snapshotted at booking time (migration 0092, lib/booking/service.ts's
      // priceBookingSlots) from the resource type's own tax rate — same
      // discipline rate_applied already uses. 0 means no 'resources'/'both'
      // tax rate was configured for that type at booking time.
      taxPercent: Number(s.taxRatePercent),
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
 *
 * `void_status = 'active'` (migration 0073): a voided or comped line is
 * excluded here exactly the way a `billed`/`pending` order already is — this
 * is what actually takes the amount off the tab. voidOrderItemCore
 * (lib/orders/service.ts) never deletes the row, so it still exists for the
 * void/comp report (M20); it just never reaches a bill again.
 */
export async function loadFoodLines(
  tx: Db,
  tenantId: string,
  bookingId: string,
  /**
   * Restrict to exactly these orders — the set lockOpenFoodOrders() captured.
   *
   * Omit it to read "whatever is open right now", which is what the DISPLAY
   * path wants (lib/billing/data.ts). The INVOICE path must pass the locked
   * set: see the note on lockOpenFoodOrders() for why reading and flipping
   * different sets loses money.
   *
   * An EMPTY array means "no orders", not "no filter" — the distinction
   * matters, because a booking with nothing open must produce no food lines
   * rather than all of them.
   */
  orderIds?: readonly string[],
): Promise<BillLine[]> {
  if (orderIds && orderIds.length === 0) return []

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
        eq(orderItems.voidStatus, 'active'),
        orderIds ? inArray(orders.id, [...orderIds]) : undefined,
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
 *
 * `void_status = 'active'` (migration 0073) — same exclusion loadFoodLines
 * applies, so a voided/comped line on a standalone pay-now order is never
 * charged either.
 */
export async function loadOrderFoodLines(
  tx: Db,
  tenantId: string,
  orderId: string,
): Promise<BillLine[]> {
  // Pins order_items_public_select (migration 0067) to this one order — a
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
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, orderId),
        eq(orderItems.voidStatus, 'active'),
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
  /** Passed straight through to loadFoodLines — see its `orderIds` note. */
  orderIds?: readonly string[],
): Promise<BillLine[]> {
  // Sequential, not Promise.all: both share ONE transaction client, and a
  // Postgres connection cannot run two queries at once (see lib/billing/receipt.ts).
  const bookingLines = await loadBookingLines(tx, tenantId, bookingId, timeZone)
  const foodLines = await loadFoodLines(tx, tenantId, bookingId, orderIds)
  return [...bookingLines, ...foodLines]
}

/**
 * Take the open food orders for a booking and hold them for the rest of the
 * transaction, returning exactly which ones were taken.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Step 1 of issueInvoiceForBooking locks the BOOKING row, which serialises two
 * concurrent billings of the same booking — that is what makes double-billing
 * impossible. It does nothing about food orders arriving mid-flight, because a
 * row lock cannot prevent an INSERT.
 *
 * That left a gap in the opposite direction. `loadFoodLines` read the open
 * orders, and step 7 then flipped `status='open' → 'billed'` with an UNSCOPED
 * predicate. An order created between those two statements was invisible to the
 * read but caught by the flip: marked billed, never charged, and gone from
 * every future bill. Money silently lost — the mirror image of double-billing,
 * and easier to miss because nobody complains about not being charged.
 *
 * Capturing the ids once and using that SAME set for both the read and the
 * flip closes it. An order that arrives after this call is in neither, so it
 * simply stays open and lands on the next invoice, which is correct.
 *
 * FOR UPDATE on top of that stops a concurrent cancel from changing an order's
 * status between the read and the flip.
 *
 * Rare today — staff bill from the same terminal they order at — but customer
 * self-service ordering makes "customer taps Order as the cashier taps Bill" an
 * ordinary Friday night.
 */
export async function lockOpenFoodOrders(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.bookingId, bookingId),
        eq(orders.status, 'open'),
      ),
    )
    .for('update')

  return rows.map((r) => r.id)
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

/** One booking's live billing state — either a normal single invoice, or every
 *  check of a split bill (M18 #2), sharing one bill_group_id. */
export type LiveBilling =
  | { kind: 'single'; invoice: ExistingInvoice }
  | { kind: 'split'; billGroupId: string; checks: (ExistingInvoice & { billGroupSeq: number })[] }

/**
 * The booking's full live billing state, generalising findLiveInvoice to also
 * recognise a split bill (migration 0089): a booking may still only ever have
 * ONE live billing episode, but that episode is now either a single invoice
 * (bill_group_id null, exactly today's shape) or every check of a split
 * (several invoices sharing one bill_group_id). Used wherever code must
 * refuse a second bill/split against an already-billed booking — see
 * issueInvoiceForBooking, issueSplitBillForBooking (lib/billing/split.ts) and
 * requireNoLiveInvoice (lib/booking/service.ts).
 *
 * Ordered by bill_group_seq so a split's checks always come back "Check 1,
 * Check 2, …" — the order the UI and every caller expects.
 */
export async function findLiveBilling(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<LiveBilling | null> {
  const rows = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      billGroupId: invoices.billGroupId,
      billGroupSeq: invoices.billGroupSeq,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.bookingId, bookingId),
        ne(invoices.status, 'void'),
      ),
    )
    .orderBy(invoices.billGroupSeq)

  if (rows.length === 0) return null
  if (rows[0].billGroupId === null) {
    // Invariant (enforced by every writer): a booking is never both a plain
    // invoice AND a split at once, so a null bill_group_id here means every
    // row is — there is only ever one.
    return { kind: 'single', invoice: rows[0] }
  }
  return {
    kind: 'split',
    billGroupId: rows[0].billGroupId,
    checks: rows.map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber, status: r.status, billGroupSeq: r.billGroupSeq! })),
  }
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
  /**
   * Bill-level comp/discount (M18 #5) — a manager-authorised write-off on
   * top of everything else. `membershipId` is who authorised it (frozen onto
   * the invoice and the audit_log row), NOT re-derived here — the caller
   * (lib/actions/billing.ts) has already checked isManager(ctx.role) and
   * ctx.tenant.industry === 'restaurant' before this ever arrives; this
   * function does not re-gate, only re-caps the amount and requires the
   * reason, same trust boundary as every other input here.
   */
  comp?: { amount: number; reason: string; membershipId: string }
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

/** What prepareBookingBill hands both issueInvoiceForBooking and
 *  issueSplitBillForBooking (lib/billing/split.ts) — everything the two
 *  paths share before they diverge on promo/loyalty (normal bill only) vs.
 *  splitting (no promo/loyalty in v1 — see lib/billing/split.ts's header). */
export type PreparedBill = {
  booking: { id: string; bookingNumber: string; branchId: string; customerId: string | null; status: string }
  billedOrderIds: string[]
  lines: BillLine[]
  /** priced with NO discount — the base subtotal a membership % applies against. */
  gross: PricingResult
  membership: AppliedMembershipBenefit | null
  membershipDiscount: number
  /** M18 #3 — computed on gross.subtotal (pre-discount), the tenant's
   *  business_profiles config resolved fresh inside this transaction. */
  serviceCharge: ServiceChargeResult
}

/**
 * Steps 1–4a of raising a bill, shared verbatim by issueInvoiceForBooking and
 * issueSplitBillForBooking: lock the booking, refuse a second live bill
 * (plain OR split — see findLiveBilling), capture+load the billable lines,
 * and resolve the automatic membership benefit. Promo codes and loyalty
 * redemption are NOT here — they stay in issueInvoiceForBooking only, since
 * a split bill applies membership (automatic) but not a manually-chosen
 * discount (v1 scope decision, see lib/billing/split.ts).
 *
 * Pure extraction from what used to be issueInvoiceForBooking's own steps
 * 1–4a: same locking, same order of operations, same error messages for the
 * single-invoice case — verified against scripts/test-billing-flow.ts and
 * friends with zero behaviour change.
 */
export async function prepareBookingBill(
  tx: Db,
  tenant: { id: string; timezone: string },
  bookingId: string,
): Promise<PreparedBill> {
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
      channel: bookings.channel,
      billingMode: bookings.billingMode,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)))
    .for('update')
    .limit(1)

  if (!booking) throw new BillingError('Booking not found.')

  if (!isBillableBookingStatus(booking.status)) {
    throw new BillingError('This booking cannot be billed in its current status.')
  }

  // ── 2. already billed? ────────────────────────────────────────────────────
  const existing = await findLiveBilling(tx, tenant.id, booking.id)
  if (existing?.kind === 'single') {
    throw new BillingError(`This booking has already been billed (${existing.invoice.invoiceNumber}).`)
  }
  if (existing?.kind === 'split') {
    throw new BillingError(
      `This booking's bill has already been split into ${existing.checks.length} checks — settle them individually.`,
    )
  }

  // A timed walk-in's slot has a committed ends_at from the moment it starts,
  // but isn't PRICED until checkoutWalkinCore runs (M21 #5) — loadBookingLines
  // silently drops that line below (so a read-only bill preview degrades
  // gracefully instead of crashing), which is fine on its own: with NO other
  // lines, the lines.length === 0 guard in step 3 still catches it. But with
  // open food orders too, that guard never fires — this general billing path
  // would raise an invoice for the food alone and silently omit the session
  // charge entirely. Reject outright instead of letting the filter hide it.
  if (booking.channel === 'walkin') {
    const [slot] = await tx
      .select({ slotTotal: bookingSlots.slotTotal, endsAt: bookingSlots.endsAt })
      .from(bookingSlots)
      .where(
        and(eq(bookingSlots.tenantId, tenant.id), eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.active, true)),
      )
      .limit(1)
    // A walk-in is billed via checkoutWalkinCore, never this general path.
    // Until it's checked out its session line isn't priced — an OPEN TAB's
    // ends_at is still null, a TIMED session's slot_total is still 0 — so
    // loadBookingLines drops it above. With open food orders too, billing here
    // would raise a food-only invoice that silently omits the session charge
    // AND, becoming the booking's live invoice, blocks checkoutWalkin forever.
    // Reject BOTH walk-in shapes, not just timed.
    const notCheckedOut =
      booking.billingMode === 'timed'
        ? slot != null && Number(slot.slotTotal) === 0
        : slot != null && slot.endsAt === null
    if (notCheckedOut) {
      throw new BillingError(
        'This walk-in has not been checked out yet — check it out from its session to bill it.',
      )
    }
  }

  // ── 3. lines, entirely from server-side data ──────────────────────────────
  // The open food orders are captured and held FIRST, and that exact set is
  // what both the lines below and the status flip in step 7 use. Reading
  // "whatever is open" and later flipping "whatever is open" are two different
  // sets under concurrency — see lockOpenFoodOrders() for what that cost.
  const billedOrderIds = await lockOpenFoodOrders(tx, tenant.id, booking.id)

  const lines = await loadBillLines(
    tx,
    tenant.id,
    booking.id,
    tenant.timezone,
    billedOrderIds,
  )
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

  // ── 4b. service charge (M18 #3) ───────────────────────────────────────────
  // Computed on gross.subtotal — the PRE-DISCOUNT figure — deliberately: a
  // membership/promo/loyalty discount is a concession on the food, not on
  // the venue's own service charge. Config is read fresh inside this same
  // transaction, never cached, so a mid-service change to the % or its tax
  // rate can never apply to a bill already in flight.
  const serviceChargeConfig = await loadServiceChargeConfig(tx, tenant.id)
  const serviceCharge = computeServiceCharge(gross.subtotal, serviceChargeConfig)

  return { booking, billedOrderIds, lines, gross, membership, membershipDiscount, serviceCharge }
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
  const { booking, billedOrderIds, lines, gross, membership, membershipDiscount, serviceCharge } =
    await prepareBookingBill(tx, tenant, input.bookingId)

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

  // ── 4d. bill-level comp (M18 #5) ──────────────────────────────────────────
  // LAST in precedence — on top of membership, promo/keyed discount AND
  // loyalty redemption. A comp is a deliberate final write-off ("waive
  // what's left"), not a discount the customer qualified for, so it takes
  // whatever the other three left rather than competing with them. Capped at
  // the remainder for the same reason every discount above is: the combined
  // total must never exceed the subtotal even before priceBill's own cap.
  // Authorization (manager + restaurant tenant) already happened in the
  // caller (lib/actions/billing.ts) — this only re-validates the reason and
  // re-caps the amount, the same trust boundary as `discount` above.
  const remainingAfterLoyalty = round2(gross.subtotal - membershipDiscount - discount - loyaltyDiscount)
  let compAmount = 0
  let compReason: string | null = null
  if (input.comp && input.comp.amount > 0) {
    if (!input.comp.reason || input.comp.reason.trim() === '') {
      throw new BillingError('A reason is required to comp or discount a bill.')
    }
    compAmount = Math.min(round2(input.comp.amount), Math.max(0, remainingAfterLoyalty))
    compReason = input.comp.reason.trim()
  }

  // The combined figure. Membership + (promo | keyed-in) + loyalty + comp —
  // capped once more at the subtotal so no combination can drive the bill
  // negative, belt and braces with priceBill's own cap.
  const totalDiscount = Math.min(
    round2(membershipDiscount + discount + loyaltyDiscount + compAmount),
    gross.subtotal,
  )

  // priceBill owns every rupee: line rounding, discount-before-GST, the
  // per-rate CGST/SGST split and the total. Nothing is recomputed here.
  const pricing = priceBill({ lines, discount: totalDiscount })

  // ── 4d. fold the service charge in (M18 #3) ───────────────────────────────
  // subtotal/discount/taxableValue stay FOOD-ONLY (unchanged meaning, zero
  // risk to every existing reader of those columns). Service charge is
  // additive: its own amount and its own tax (already computed on gross
  // subtotal by prepareBookingBill) are folded into taxTotal/taxBreakup/
  // total, exactly the numbers a printed GST receipt needs to already
  // include — a customer should see ONE "GST total", not a food one plus a
  // separate service-charge one to add by hand.
  const taxTotal = round2(pricing.taxTotal + serviceCharge.tax)
  const taxBreakup = mergeTaxBreakup(pricing.taxBreakup, {
    percent: serviceCharge.taxPercent,
    cgst: serviceCharge.cgst,
    sgst: serviceCharge.sgst,
  })
  const total = round2(pricing.taxableValue + serviceCharge.amount + taxTotal)

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
  const settledOnIssue = paise(total) === 0

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
      taxTotal: taxTotal.toFixed(2),
      // Mapped straight from priceBill (plus the service charge's own group,
      // folded in above) onto the stored TaxBreakupLine shape — `percent` is
      // the column's `rate`. No `taxable`: see TaxBreakupLine.
      taxBreakup: taxBreakup.map((g) => ({
        rate: g.percent,
        cgst: g.cgst.toFixed(2),
        sgst: g.sgst.toFixed(2),
      })),
      total: total.toFixed(2),
      status: settledOnIssue ? 'paid' : 'issued',
      issuedAt: new Date(),
      // Frozen snapshot of the config as it was when this bill was raised
      // (M18 #3) — never re-read from live settings on a reprint, same
      // discipline as membershipDiscount/membershipDiscountPercent above.
      serviceChargePercent: serviceCharge.percent.toFixed(2),
      serviceChargeAmount: serviceCharge.amount.toFixed(2),
      serviceChargeTaxPercent: serviceCharge.taxPercent.toFixed(2),
      // Bill-level comp (M18 #5) — one component of `discount` above, never
      // an extra amount alongside it. See the audit_log write below.
      compAmount: compAmount.toFixed(2),
      compReason,
      compedByMembershipId: compAmount > 0 ? (input.comp?.membershipId ?? null) : null,
    })
    .returning({ id: invoices.id })

  // Durable, append-only record of who comped this bill, how much, and why —
  // written in the SAME transaction as the invoice, so a comp can never exist
  // without its audit row (or the reverse). See writeAudit's own doc comment.
  if (compAmount > 0 && input.comp) {
    await writeAudit(tx, { tenantId: tenant.id, membershipId: input.comp.membershipId }, {
      action: 'invoice.comp',
      entityType: 'invoice',
      entityId: invoice.id,
      before: { invoice_number: invoiceNumber, subtotal: gross.subtotal.toFixed(2) },
      after: {
        invoice_number: invoiceNumber,
        amount: compAmount.toFixed(2),
        reason: compReason,
        booking_id: booking.id,
      },
    })
  }

  // ── 6. items — the historical snapshot ────────────────────────────────────
  // Every number the invoice was built from is frozen onto the row, so a later
  // price change can never move a past bill.
  const itemRows = pricing.items.map((item) => ({
    tenantId: tenant.id,
    invoiceId: invoice.id,
    kind: item.kind,
    sourceId: item.sourceId ?? null,
    description: item.description,
    qty: item.qty.toFixed(2),
    unitPrice: item.unitPrice.toFixed(2),
    taxRate: item.taxPercent.toFixed(2),
    lineTotal: item.lineTotal.toFixed(2),
  }))
  // Service charge (M18 #3) has no single order_items/booking_slots row to
  // point sourceId at — it's derived from the whole bill's subtotal, not
  // ordered — so it's its own synthetic line, same shape a food line has.
  if (paise(serviceCharge.amount) > 0) {
    itemRows.push({
      tenantId: tenant.id,
      invoiceId: invoice.id,
      kind: 'service_charge',
      sourceId: null,
      description: `Service charge (${serviceCharge.percent}%)`,
      qty: '1.00',
      unitPrice: serviceCharge.amount.toFixed(2),
      taxRate: serviceCharge.taxPercent.toFixed(2),
      lineTotal: serviceCharge.amount.toFixed(2),
    })
  }
  await tx.insert(invoiceItems).values(itemRows)

  // ── 7. mark the food orders billed ────────────────────────────────────────
  // The other half of double-billing prevention: loadFoodLines only reads
  // status='open', acceptanceStatus='accepted' orders, so flipping THE SAME
  // set to 'billed' here — in the same transaction as the invoice itself —
  // means the same fries can never end up on a second bill, and a failure
  // anywhere above rolls this back too.
  //
  // Two conditions, from two independent fixes, and both must stay:
  //   * Scoped to billedOrderIds (the set lockOpenFoodOrders captured in step
  //     3), NOT "every open order" — an unscoped flip would also catch an order
  //     created since step 3 and mark it billed without ever charging for it.
  //     Read one set, charge that set, flip that set.
  //   * acceptanceStatus='accepted', identical to loadFoodLines': a still-
  //     pending online order is status='open' too, so without this it would be
  //     flipped 'billed' without appearing on the invoice — charged-for-nothing
  //     in reverse. Pending orders are handled by step 7b below instead.
  if (billedOrderIds.length > 0) {
    await tx
      .update(orders)
      .set({ status: 'billed' })
      .where(
        and(
          eq(orders.tenantId, tenant.id),
          eq(orders.bookingId, booking.id),
          eq(orders.status, 'open'),
          eq(orders.acceptanceStatus, 'accepted'),
          inArray(orders.id, billedOrderIds),
        ),
      )
  }

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
