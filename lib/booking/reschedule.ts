/**
 * Reschedule a reserved booking to a new window (Phase 2 of the time-step work).
 *
 * One continuous slot on the SAME unit moves; everything money-shaped follows:
 * the slot is re-priced at the new time (weekend / happy-hour / holiday rules
 * resolve against the NEW window), its add-ons move with it (stock re-checked,
 * lines re-priced), and bookings.subtotal / total are refreshed. Overlaps are
 * decided by the booking_slots_no_overlap exclusion constraint - an UPDATE of
 * starts_at/ends_at is re-validated by it, and a booking never conflicts with
 * its own old row - so a clash surfaces as SQLSTATE 23P01 (the action turns it
 * into "that time was just taken").
 *
 * Rules, enforced here and not only in the UI:
 *   - confirmed          -> start, end and date may change
 *   - checked_in         -> end only (the session is under way; the start is history)
 *   - pending_payment / completed / cancelled / no_show -> refused
 *   - walk-ins, backdated entries, table reservations/sessions, event blocks -> refused
 *   - already billed (live invoice) -> refused: the bill is frozen with the booking
 *   - single, hourly, non-setup slot only (v1)
 *   - the new window must sit on the venue's time step and inside working hours,
 *     inside the advance-booking window, and not in the past
 *
 * Money rules:
 *   - Re-pricing: the slot is priced at TODAY's rates for the NEW window, even
 *     for a same-length move. The dialog's quote says so before staff confirm.
 *   - Discount: bookings.discount is a fixed rupee amount staff keyed in. It is
 *     carried over unchanged, but never above the new subtotal: if the new window
 *     is cheaper than the discount, the stored discount is reduced to the
 *     subtotal (total 0) and the plan reports discountClamped. Percent promo
 *     codes and loyalty redemptions are NOT held on the booking - they are
 *     evaluated against the bill when it is raised, so they apply to the new
 *     price automatically and nothing needs recomputing here.
 *   - Money already collected (online deposit with a paid intent, or an M26/M30
 *     cash/UPI advance in advance_payments): if the new total drops below it, the
 *     booking is flagged depositReviewRequired - the same "go refund this
 *     customer" flag cancel raises. Nothing is refunded automatically.
 *   - The customer is texted the old and new time after the change commits.
 *
 * planReschedule is read-only and also backs the live quote the dialog shows;
 * rescheduleBookingCore is the same plan, locked, then applied and audited.
 */
import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { bookings, bookingSlots, paymentIntents } from '@/db/schema'
import { findLiveBilling, writeAudit } from '@/lib/billing/invoice'
import { advancePaidTotal } from './advance-ledger'
import { round2 } from '@/lib/billing/pricing'
import { BookingError } from './booking-error'
import { rescheduleSlotAddons } from './addons'
import { assertWithinAdvanceWindow, priceBookingSlots, type PricedBookingSlot } from './service'
import { getBookingSettingsCore } from './settings'
import { GridRefusedError, slotsGridError } from './slot-grid'

type Db = NodePgDatabase<typeof schema>

const MIN = 60_000

export type RescheduleInput = {
  bookingId: string
  newStartsAt: Date
  newEndsAt: Date
  /** The slot start the caller saw. A mismatch means someone else changed the booking meanwhile. */
  expectedStartsAt: Date
  reason?: string
  /** Manager override of the slot-grid rule. Callers must already be role-gated
   *  (rescheduling is manager-only); the refusal is audited with `reason`. */
  allowOffGrid?: boolean
}

export type ReschedulePlan = {
  /** The grid refusal that was overridden, or null when the window is on the grid. */
  gridOverride: string | null
  bookingId: string
  bookingNumber: string
  status: 'confirmed' | 'checked_in'
  branchId: string
  slotId: string
  resourceId: string
  resourceName: string
  oldStartsAt: Date
  oldEndsAt: Date
  newStartsAt: Date
  newEndsAt: Date
  oldTotal: number
  newTotal: number
  newSubtotal: number
  /** The discount that will be stored: the old one, capped at the new subtotal. */
  newDiscount: number
  /** The old fixed discount exceeded the new price and was reduced. */
  discountClamped: boolean
  discount: number
  /** The deposit already paid online / held against this booking. */
  deposit: number
  priced: PricedBookingSlot
  /** Re-priced add-on total for the new window (0 with no add-ons). */
  addonTotal: number
  /** The new total is below money already collected online: flag for a manual refund. */
  needsRefundReview: boolean
}

type Ctx = { tenantId: string; timezone: string }

export async function planReschedule(
  tx: Db,
  ctx: Ctx,
  input: RescheduleInput,
  opts: { lock: boolean },
): Promise<ReschedulePlan> {
  const q = tx
    .select({
      id: bookings.id,
      bookingNumber: bookings.bookingNumber,
      status: bookings.status,
      branchId: bookings.branchId,
      channel: bookings.channel,
      backdated: bookings.backdated,
      reservedFor: bookings.reservedFor,
      tableResourceId: bookings.resourceId,
      total: bookings.total,
      discount: bookings.discount,
      deposit: bookings.deposit,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenantId)))
    .limit(1)
  const [booking] = opts.lock ? await q.for('update') : await q
  if (!booking) throw new BookingError('Booking not found.')

  if (booking.status === 'pending_payment') {
    throw new BookingError('This booking is awaiting the customer’s online payment - it cannot be moved until the payment arrives.')
  }
  if (booking.status !== 'confirmed' && booking.status !== 'checked_in') {
    throw new BookingError('Only an upcoming or in-progress booking can be rescheduled.')
  }
  if (booking.channel === 'walkin') {
    throw new BookingError('A walk-in cannot be rescheduled - use Extend or Correct end time instead.')
  }
  if (booking.backdated) throw new BookingError('A late-entered booking cannot be rescheduled.')
  if (booking.reservedFor || booking.tableResourceId) {
    throw new BookingError('A table reservation can’t be rescheduled here - cancel it and book a new one.')
  }
  if (await findLiveBilling(tx, ctx.tenantId, booking.id)) {
    throw new BookingError('This booking has already been billed - its time is frozen with the bill.')
  }

  const slotQ = tx
    .select({
      id: bookingSlots.id,
      resourceId: bookingSlots.resourceId,
      resourceName: bookingSlots.resourceName,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
      setupId: bookingSlots.setupId,
      rateUnit: bookingSlots.rateUnit,
      headCount: bookingSlots.headCount,
      eventId: bookingSlots.eventId,
    })
    .from(bookingSlots)
    .where(
      and(eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.tenantId, ctx.tenantId), eq(bookingSlots.active, true)),
    )
  const slots = opts.lock ? await slotQ.for('update') : await slotQ
  if (slots.length !== 1) {
    throw new BookingError('Only a booking with a single time slot can be rescheduled for now.')
  }
  const slot = slots[0]
  if (slot.eventId || slot.endsAt === null) throw new BookingError('This booking cannot be rescheduled.')
  if (slot.setupId || slot.rateUnit !== 'hour') {
    throw new BookingError('A booking for a named setup or a per-day rate cannot be rescheduled yet - cancel and rebook it.')
  }
  const oldStartsAt = slot.startsAt
  const oldEndsAt = slot.endsAt

  if (oldStartsAt.getTime() !== input.expectedStartsAt.getTime()) {
    throw new BookingError('This booking was changed by someone else. Reload and try again.')
  }
  if (!(input.newEndsAt > input.newStartsAt)) throw new BookingError('The booking must end after it starts.')
  if (input.newStartsAt.getTime() === oldStartsAt.getTime() && input.newEndsAt.getTime() === oldEndsAt.getTime()) {
    throw new BookingError('That is already the booking’s time.')
  }

  const now = new Date()
  const { slotStepMinutes } = await getBookingSettingsCore(tx, ctx.tenantId)
  const endOnly = booking.status === 'checked_in'
  if (endOnly) {
    if (input.newStartsAt.getTime() !== oldStartsAt.getTime()) {
      throw new BookingError('This booking has already started - only its end time can change.')
    }
    if (input.newEndsAt <= now) throw new BookingError('The new end time must be in the future.')
  } else if (input.newStartsAt.getTime() + slotStepMinutes * MIN <= now.getTime()) {
    throw new BookingError('That start time has already passed.')
  }

  const window = [{ startsAt: input.newStartsAt.toISOString(), endsAt: input.newEndsAt.toISOString() }]
  const gridError = await slotsGridError(tx, ctx, booking.branchId, window, { endOnly })
  if (gridError && !input.allowOffGrid) throw new GridRefusedError(gridError, true)
  if (!endOnly) {
    await assertWithinAdvanceWindow(tx, ctx, [{ startsAt: input.newStartsAt, endsAt: input.newEndsAt }])
  }

  const priced = (
    await priceBookingSlots(tx, ctx, {
      branchId: booking.branchId,
      slots: [{ resourceId: slot.resourceId, startsAt: window[0].startsAt, endsAt: window[0].endsAt }],
      headCount: slot.headCount ?? undefined,
    })
  ).slots[0]

  const addonTotal = await rescheduleSlotAddons(tx, ctx.tenantId, slot.id, input.newStartsAt, input.newEndsAt, {
    dryRun: true,
  })
  const newSubtotal = round2(Number(priced.slotTotal) + addonTotal)
  const discount = Number(booking.discount)
  const newDiscount = Math.min(discount, newSubtotal)
  const discountClamped = discount - newDiscount > 0.004
  const newTotal = round2(Math.max(0, newSubtotal - newDiscount))
  const oldTotal = Number(booking.total)
  const deposit = Number(booking.deposit)

  // Money already collected that the new, lower total no longer needs: the same
  // "go refund this customer" flag cancel raises. An online deposit counts only if
  // a paid intent exists; an M26/M30 advance counts from the ledger (a booking
  // with an invoice is refused above, so every tender here is unconsumed).
  // Over-flagging is safe; under-flagging is not.
  let needsRefundReview = false
  if (newTotal < oldTotal - 0.004 && (await advancePaidTotal(tx, ctx.tenantId, booking.id)) > newTotal + 0.004) {
    needsRefundReview = true
  }
  if (!needsRefundReview && newTotal < oldTotal - 0.004 && deposit > newTotal + 0.004) {
    const [paid] = await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, ctx.tenantId),
          eq(paymentIntents.bookingId, booking.id),
          eq(paymentIntents.purpose, 'booking_deposit'),
          eq(paymentIntents.status, 'paid'),
        ),
      )
      .limit(1)
    needsRefundReview = !!paid
  }

  return {
    gridOverride: gridError,
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    branchId: booking.branchId,
    slotId: slot.id,
    resourceId: slot.resourceId,
    resourceName: slot.resourceName ?? priced.resourceName,
    oldStartsAt,
    oldEndsAt,
    newStartsAt: input.newStartsAt,
    newEndsAt: input.newEndsAt,
    oldTotal,
    newTotal,
    newSubtotal,
    newDiscount,
    discountClamped,
    discount,
    deposit,
    priced,
    addonTotal,
    needsRefundReview,
  }
}

/** Apply a reschedule: lock, re-plan on the locked rows, write, audit. Returns the plan applied. */
export async function rescheduleBookingCore(
  tx: Db,
  ctx: Ctx & { membershipId: string | null },
  input: RescheduleInput,
): Promise<ReschedulePlan> {
  if (!input.reason?.trim()) throw new BookingError('Give a reason for the change.')
  const plan = await planReschedule(tx, ctx, input, { lock: true })
  const p = plan.priced

  // The exclusion constraint re-validates the new range here (23P01 on a clash).
  await tx
    .update(bookingSlots)
    .set({
      startsAt: plan.newStartsAt,
      endsAt: plan.newEndsAt,
      rateApplied: p.rateApplied,
      slotTotal: p.slotTotal,
      taxRatePercent: p.taxRatePercent,
      headCount: p.headCount,
      pricingMode: p.pricingMode,
      happyHourApplied: p.happyHourApplied,
      holidayRateApplied: p.holidayRateApplied,
      extraPlayerRateApplied: p.extraPlayerRateApplied,
    })
    .where(and(eq(bookingSlots.id, plan.slotId), eq(bookingSlots.tenantId, ctx.tenantId)))

  // Moves the add-on rows with the slot, re-checking pooled stock for the new
  // window. Its total already matches the dry-run in the plan (same rows, same window).
  await rescheduleSlotAddons(tx, ctx.tenantId, plan.slotId, plan.newStartsAt, plan.newEndsAt)

  const set: Partial<typeof bookings.$inferInsert> = {
    subtotal: plan.newSubtotal.toFixed(2),
    total: plan.newTotal.toFixed(2),
  }
  if (plan.discountClamped) set.discount = plan.newDiscount.toFixed(2)
  if (plan.needsRefundReview) set.depositReviewRequired = true
  await tx.update(bookings).set(set).where(and(eq(bookings.id, plan.bookingId), eq(bookings.tenantId, ctx.tenantId)))

  if (ctx.membershipId) {
    await writeAudit(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId }, {
      action: 'booking.rescheduled',
      entityType: 'booking',
      entityId: plan.bookingId,
      before: {
        startsAt: plan.oldStartsAt.toISOString(),
        endsAt: plan.oldEndsAt.toISOString(),
        total: plan.oldTotal.toFixed(2),
        discount: plan.discount.toFixed(2),
      },
      after: {
        startsAt: plan.newStartsAt.toISOString(),
        endsAt: plan.newEndsAt.toISOString(),
        total: plan.newTotal.toFixed(2),
        discount: plan.newDiscount.toFixed(2),
        reason: input.reason.trim(),
        ...(plan.gridOverride ? { gridOverride: plan.gridOverride } : {}),
        refundReviewFlagged: plan.needsRefundReview,
        discountClamped: plan.discountClamped,
      },
    })
  }
  return plan
}
