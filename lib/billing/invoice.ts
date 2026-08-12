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
import { bookings, bookingSlots, invoices, invoiceItems } from '@/db/schema'
import { durationHours } from '@/lib/booking/availability'
import { todayInZone } from '@/lib/booking/time'
import { timeInZone } from '@/lib/format'
import { loadInvoicePrefix } from '@/lib/settings/business-profile'
import { paise } from './payments'
import { priceBill, type BillLine, type PricingResult } from './pricing'
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
 * Every billable line for a booking.
 *
 * FOOD CHARGES BELONG HERE and are not yet possible: `orders` / `order_items`
 * do not exist — food ordering is milestone M2 (docs/ROADMAP.md epic M2-B) — so
 * there is no table to read and no cancelled/voided rule to honour. This is the
 * single seam for them: concatenate the food lines onto this array and the rest
 * of the pipeline (priceBill, invoice_items, the bill screen's Food section)
 * already handles `kind: 'food'` with no further change.
 */
export async function loadBillLines(
  tx: Db,
  tenantId: string,
  bookingId: string,
  timeZone: string,
): Promise<BillLine[]> {
  return loadBookingLines(tx, tenantId, bookingId, timeZone)
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
}

export type IssuedInvoice = {
  invoiceId: string
  invoiceNumber: string
  pricing: PricingResult
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

  // ── 4. promo ──────────────────────────────────────────────────────────────
  // A percentage promo is a percentage OF THE SUBTOTAL, so the subtotal has to
  // exist before the code can be priced. Pricing with no discount gives it —
  // priceBill is pure, so calling it twice costs nothing and keeps it the only
  // thing in the codebase that adds up a bill.
  const promoCode = normalizePromoCode(input.promoCode)
  let promoId: string | null = null
  let discount = input.discount

  if (promoCode) {
    const gross = priceBill({ lines })
    const promo = await validatePromo(tx, tenant.id, promoCode, gross.subtotal)
    // An invalid code stops the bill. Billing anyway at full price would
    // silently overcharge a customer who was promised the discount.
    if (!promo.ok) throw new BillingError(promo.reason)
    // The promo replaces any manually typed discount rather than stacking with
    // it, so a code and a keyed-in figure can never compound into more off than
    // either was worth.
    promoId = promo.promoId
    discount = promo.discount
  }

  // priceBill owns every rupee: line rounding, discount-before-GST, the
  // per-rate CGST/SGST split and the total. Nothing is recomputed here.
  const pricing = priceBill({ lines, discount })

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

  return { invoiceId: invoice.id, invoiceNumber, pricing }
}
