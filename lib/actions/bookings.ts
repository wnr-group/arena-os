'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { bookings, bookingSlots } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import {
  createBookingCore,
  priceBookingSlots,
  seatTableSessionCore,
  requestBillCore,
  transferTableCore,
  mergeTablesCore,
  splitTableCore,
  assertBookingFullyPaid,
  BookingError,
} from '@/lib/booking/service'
import {
  startWalkinCore,
  checkoutWalkinCore,
  extendWalkinCore,
  previewWalkinCheckout as previewWalkinCheckoutCore,
  listWalkinResources as listWalkinResourcesForBranch,
  listActiveWalkins,
  WALKIN_MIN_DURATION_MINUTES,
  WALKIN_MAX_DURATION_MINUTES,
  WALKIN_DURATION_STEP_MINUTES,
  WALKIN_EXTEND_MAX_MINUTES,
  type WalkinResourceOption,
} from '@/lib/booking/walkin'
import { BillingError } from '@/lib/billing/invoice'
import { loadWeekendDays } from '@/lib/settings/business-profile'
import { cancelOpenOrdersForBooking } from '@/lib/orders/service'
import { isValidPhone } from '@/lib/customers/phone'
import { findCustomerByRawPhone } from '@/lib/customers/service'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type CreateResult = { error?: string; bookingId?: string; bookingNumber?: string }
type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof BookingError || e instanceof BillingError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const pg = pgError(e)
  // 23P01 = exclusion_violation: the exclusion constraint caught an overlap.
  if (pg?.code === '23P01') {
    return { error: 'That time was just taken for one of the selected resources. Please pick another slot.' }
  }
  // 23505 on idx_bookings_open_table_session = someone else just seated (or
  // was just transferred/split onto) this table (see 0071_table_sessions.sql)
  // — the DB caught the race, not us.
  if (pg?.code === '23505' && pg.constraint === 'idx_bookings_open_table_session') {
    return { error: 'That table was just taken. Pick another table.' }
  }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const createInput = z.object({
  branchId: z.string().uuid(),
  customerName: z.string().trim().min(1, 'Customer name is required.'),
  customerPhone: z
    .string()
    .trim()
    .min(1, 'Phone number is required.')
    .refine((v) => isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  customerEmail: z.string().trim().email().optional().or(z.literal('')),
  notes: z.string().trim().optional(),
  source: z.enum(['walk_in', 'staff', 'online']).default('staff'),
  discount: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  slots: z
    .array(
      z.object({
        resourceId: z.string().uuid(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
      }),
    )
    .min(1, 'Add at least one resource slot'),
  // M21 per-head #4: player count for a per_head resource type — required
  // (and validated against min_players) by priceBookingSlots itself when a
  // slot's resource type turns out to be per_head; meaningless and ignored
  // otherwise.
  headCount: z.coerce.number().int().min(1).optional(),
})

/** Server action: create a booking across one or more resource slots for the signed-in tenant. */
export async function createBooking(input: z.input<typeof createInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    const v = createInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      createBookingCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId }, v),
    )

    revalidatePath('/bookings')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

const quoteBookingInput = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  // M21 per-head #4: required only when the resource turns out to be
  // per_head — priceBookingSlots itself validates that, same as createBooking.
  headCount: z.coerce.number().int().min(1).optional(),
})

/**
 * Happy hours #2: read-only price quote for the staff "New Booking" wizard's
 * (FutureWizard.tsx) live estimate — the exact same priceBookingSlots call
 * createBooking itself makes (day rate -> happy-hour discount per segment ->
 * x players, see lib/booking/service.ts), so what the wizard shows before
 * booking can never drift from what createBooking actually charges. Writes
 * nothing, same "preview, don't commit" shape as previewWalkinCheckout below.
 *
 * No extra role/industry gate beyond requireContext() — same as createBooking
 * itself, which this merely previews.
 */
export async function quoteBooking(
  input: z.input<typeof quoteBookingInput>,
): Promise<{ error?: string; total?: number }> {
  try {
    const ctx = await requireContext()
    const v = quoteBookingInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      priceBookingSlots(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone }, {
        branchId: v.branchId,
        slots: [{ resourceId: v.resourceId, startsAt: v.startsAt, endsAt: v.endsAt }],
        headCount: v.headCount,
      }),
    )
    return { total: result.subtotal }
  } catch (e) {
    return fail(e)
  }
}

const WALKIN_INDUSTRY_ERROR = 'Walk-ins are not enabled for this business.'

const startWalkinInput = z
  .object({
    branchId: z.string().uuid(),
    resourceId: z.string().uuid(),
    phone: z
      .string()
      .trim()
      .min(1, 'Phone number is required.')
      .refine((v) => isValidPhone(v), 'Enter a valid 10-digit phone number.'),
    name: z.string().trim().optional(),
    startAt: z.string().datetime(),
    mode: z.enum(['open_tab', 'timed']),
    durationMin: z.coerce.number().int().optional(),
    // M21 per-head #4: player count for a per_head station — required (and
    // validated against min_players) by startWalkinCore itself when the
    // resource turns out to be per_head; ignored otherwise.
    headCount: z.coerce.number().int().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode !== 'timed') return
    if (
      v.durationMin === undefined ||
      v.durationMin < WALKIN_MIN_DURATION_MINUTES ||
      v.durationMin > WALKIN_MAX_DURATION_MINUTES ||
      v.durationMin % WALKIN_DURATION_STEP_MINUTES !== 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMin'],
        message: `Pick a duration between ${WALKIN_MIN_DURATION_MINUTES} minutes and ${WALKIN_MAX_DURATION_MINUTES / 60} hours, in ${WALKIN_DURATION_STEP_MINUTES}-minute steps.`,
      })
    }
  })

/**
 * Start a walk-in session (M21 #3) — the non-restaurant sibling of seatTable.
 * Gated at the action layer like every other industry-scoped action here: a
 * restaurant tenant (which uses M17 Seat-a-party instead) or a role outside
 * WALKIN_ROLES gets rejected here regardless of what the client sent, even if
 * the chooser/start form were somehow bypassed.
 */
export async function startWalkin(input: z.input<typeof startWalkinInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant') {
      throw new AuthError(WALKIN_INDUSTRY_ERROR)
    }
    if (!canManageWalkins(ctx.role)) {
      throw new AuthError('You do not have permission to start a walk-in.')
    }
    const v = startWalkinInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      startWalkinCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        v,
      ),
    )

    revalidatePath('/bookings')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Free/occupied hourly stations for the walk-in start form's station picker.
 * Same industry/role gate as startWalkin — read-only, but a restaurant
 * tenant or unauthorized role has no legitimate reason to see it either.
 *
 * M22 bugfix: also returns the tenant's weekend_days, alongside each
 * resource's weekendRate (WalkinResourceOption) — the form combines them
 * with lib/booking/rate.ts's isWeekendDay/resolveDayRate (the SAME pure
 * resolver startWalkinCore itself uses) to show a live rate estimate that
 * tracks the staff-chosen start time, instead of always showing the
 * weekday rate even when that start time falls on a weekend.
 */
export async function listWalkinResources(
  branchId: string,
): Promise<{ error?: string; resources?: WalkinResourceOption[]; weekendDays?: number[] }> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant') {
      throw new AuthError(WALKIN_INDUSTRY_ERROR)
    }
    if (!canManageWalkins(ctx.role)) {
      throw new AuthError('You do not have permission to start a walk-in.')
    }
    const [resources, weekendDays] = await Promise.all([
      listWalkinResourcesForBranch(ctx, branchId),
      withUser(ctx.user.id, (tx) => loadWeekendDays(tx, ctx.tenant.id)),
    ])
    return { resources, weekendDays }
  } catch (e) {
    return fail(e)
  }
}

const checkoutWalkinInput = z.object({
  bookingId: z.string().uuid(),
  // Absent means "now" — see checkoutWalkinCore's default.
  endAt: z.string().datetime().optional(),
  // M21 per-head #4: an edited player count for a per_head walk-in — absent
  // means "keep whatever was captured at start" (see resolveHeadCount in
  // lib/booking/walkin.ts). Like endAt, this travels with the preview/
  // checkout pair and is only WRITTEN to booking_slots/bookings at the
  // moment checkoutWalkinCore actually runs, never by the preview.
  headCount: z.coerce.number().int().min(1).optional(),
})

type CheckoutWalkinResult = { error?: string; bookingId?: string; total?: number }

/**
 * Read-only: what checkoutWalkin would charge for the given end time, for the
 * checkout dialog's live-updating amount as the operator nudges the ±30-min
 * slider. Same gate as starting a walk-in — closing one is the same
 * capability. Writes nothing; the real checkoutWalkin re-derives this from
 * scratch under a lock.
 */
export async function previewWalkinCheckout(
  input: z.input<typeof checkoutWalkinInput>,
): Promise<{
  error?: string
  total?: number
  billableEnd?: string
  /** M21 per-head #4: the head count this preview priced at (echoes back
   *  input.headCount when provided, else whatever was captured at start),
   *  plus the type's live min_players — so the checkout dialog's Players
   *  control can initialise and validate without a second round trip. */
  headCount?: number
  minPlayers?: number
  pricingMode?: string
}> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant') {
      throw new AuthError(WALKIN_INDUSTRY_ERROR)
    }
    if (!canManageWalkins(ctx.role)) {
      throw new AuthError('You do not have permission to check out a walk-in.')
    }
    const v = checkoutWalkinInput.parse(input)
    const result = await withUser(ctx.user.id, (tx) =>
      previewWalkinCheckoutCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone }, v),
    )
    return result
  } catch (e) {
    return fail(e)
  }
}

/**
 * Close out a walk-in's session — an open tab's end time (M21 #4) or a timed
 * session's committed end plus any extensions (M21 #5, blocked until the
 * operator extends past "now" if it's already passed): prices it and freezes
 * the slot (checkoutWalkinCore), same as before.
 *
 * M22 follow-up (user-reported): this used to ALSO raise the invoice in the
 * same transaction, straight to the amount checkoutWalkinCore computed, with
 * no chance to review it or apply a discount first — unlike a reserved
 * booking, which always goes through the POS bill screen (review the
 * amount, optionally discount/promo/loyalty/comp, THEN "Generate bill")
 * before an invoice exists. Closing a walk-in tab no longer raises the
 * invoice at all: it now hands off to that SAME bill screen
 * (/pos/[bookingId] → BillScreen) instead, exactly like a reserved booking —
 * getBillableForBooking already renders a checked-out-but-unbilled walk-in
 * correctly (loadBookingLines bills it as one qty=1 line at the frozen
 * slot_total the instant ends_at/slot_total are set, same as any other
 * pre-bill booking), so no new pre-bill code was needed here, only removing
 * the invoice step.
 *
 * canManageWalkins (receptionist/floor_staff included, M21 #7) still gates
 * CLOSING the tab — nothing changes there. What changed is who may then
 * raise the bill on that follow-on screen: canBillBooking (lib/auth/roles.ts)
 * carries the SAME walk-in exception forward into createInvoiceForBooking/
 * previewPromoCodeForBooking (lib/actions/billing.ts) and the /pos page
 * itself, so on-shift floor staff can still close AND bill a walk-in
 * themselves, without a cashier handoff — see canBillBooking's own doc
 * comment for the full reasoning. A RESERVED booking on that same screen
 * still requires plain canBill, unchanged.
 *
 * The booking itself is NOT marked completed here — a walk-in (non-restaurant)
 * now auto-completes when the invoice raised from the bill screen is fully
 * settled (completeBookingIfFullySettled, via recordPayment), not by a separate
 * manual step.
 */
export async function checkoutWalkin(input: z.input<typeof checkoutWalkinInput>): Promise<CheckoutWalkinResult> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant') {
      throw new AuthError(WALKIN_INDUSTRY_ERROR)
    }
    if (!canManageWalkins(ctx.role)) {
      throw new AuthError('You do not have permission to check out a walk-in.')
    }
    const v = checkoutWalkinInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      checkoutWalkinCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone }, v),
    )

    revalidatePath('/bookings')
    revalidatePath(`/pos/${result.bookingId}`)
    return { bookingId: result.bookingId, total: result.total }
  } catch (e) {
    return fail(e)
  }
}

const extendWalkinInput = z.object({
  bookingId: z.string().uuid(),
  addMinutes: z.coerce.number().int().min(1).max(WALKIN_EXTEND_MAX_MINUTES),
})

type ExtendWalkinResult = { error?: string; bookingId?: string; committedEndAt?: string }

/**
 * Push a timed walk-in's committed end forward (M21 #5) — the countdown
 * badge re-arms from whatever `committedEndAt` this returns. Same gate as
 * starting/checking out a walk-in; no money moves here, only at checkout.
 */
export async function extendWalkin(input: z.input<typeof extendWalkinInput>): Promise<ExtendWalkinResult> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant') {
      throw new AuthError(WALKIN_INDUSTRY_ERROR)
    }
    if (!canManageWalkins(ctx.role)) {
      throw new AuthError('You do not have permission to extend a walk-in.')
    }
    const v = extendWalkinInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) => extendWalkinCore(tx, { tenantId: ctx.tenant.id }, v))

    revalidatePath('/bookings')
    return result
  } catch (e) {
    // 23P01 here specifically means the extension would now overlap
    // something else booked on this resource right after the OLD committed
    // end — friendlier than the generic "pick another slot" wording, which
    // reads oddly for an in-progress session that isn't being re-slotted.
    const pg = pgError(e)
    if (pg?.code === '23P01') {
      return { error: 'Can’t extend — this device has another booking starting soon. Try a shorter extension.' }
    }
    return fail(e)
  }
}

export type ActiveWalkinAlarmRow = {
  bookingId: string
  resourceName: string
  customerName: string | null
  customerPhone: string | null
  billingMode: 'open_tab' | 'timed'
  endsAt: string | null
  slotTotal: string
  /** Minutes before endsAt the heads-up should fire — bookings.warning_minutes. */
  warningMinutes: number
}

/**
 * Bare-bones active-walk-in read for the top bar's global time's-up alarm —
 * polled from every page, not just /sessions, so the alarm fires wherever
 * staff happen to be. Fails soft to an empty list (never throws) since a
 * background poll erroring out is noise, not something a toast should
 * surface; the gate itself matches every other walk-in action, just quiet
 * instead of returning `{ error }`.
 */
export async function listActiveWalkinsForAlarm(branchId: string): Promise<{ sessions: ActiveWalkinAlarmRow[] }> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant' || !canManageWalkins(ctx.role)) {
      return { sessions: [] }
    }
    const rows = await listActiveWalkins(ctx, branchId)
    return {
      sessions: rows.map((w) => ({
        bookingId: w.bookingId,
        resourceName: w.resourceName,
        customerName: w.customerName,
        customerPhone: w.customerPhone,
        billingMode: w.billingMode,
        endsAt: w.endsAt ? w.endsAt.toISOString() : null,
        slotTotal: w.slotTotal,
        warningMinutes: w.warningMinutes,
      })),
    }
  } catch {
    return { sessions: [] }
  }
}

const seatTableInput = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  coverCount: z.coerce.number().int().positive('Guest count must be at least 1.'),
  customerName: z.string().trim().optional(),
  customerPhone: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  notes: z.string().trim().optional(),
})

/**
 * Seat a walk-in party at a table (M17 #1) — the restaurant-only sibling of
 * createBooking. Gated at the action layer, not just by hiding the UI: a
 * non-restaurant tenant that somehow reaches this action (a stale tab, a
 * replayed request) gets rejected here regardless of what the client sent,
 * per the epic's "industry-gated" rule.
 */
export async function seatTable(input: z.input<typeof seatTableInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    const v = seatTableInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      seatTableSessionCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        v,
      ),
    )

    revalidatePath('/floor')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Flag a table session's bill as requested (M17 #2) — the floor map's
 * "bill_requested" status has no other signal to derive it from (see
 * lib/booking/table-status.ts), so this just stamps the timestamp.
 * Industry-gated like seatTable: the column only means anything for a
 * table session, but the gate is enforced here, not assumed from the column
 * being unused elsewhere. requestBillCore itself re-validates that this is
 * still an active (checked_in) table session before writing — same
 * lockTableSession check transferTable/mergeTables/splitTable get, so a
 * stale/cancelled/timed booking can't have the flag stamped on it.
 */
export async function requestBill(bookingId: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    await withUser(ctx.user.id, (tx) => requestBillCore(tx, { tenantId: ctx.tenant.id }, bookingId))
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const transferTableInput = z.object({
  bookingId: z.string().uuid(),
  targetResourceId: z.string().uuid(),
})

/** Move a table session to a different table (M17 #5) — its orders follow
 *  automatically since they key off the booking, not the table. */
export async function transferTable(input: z.input<typeof transferTableInput>): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    const v = transferTableInput.parse(input)
    await withUser(ctx.user.id, (tx) =>
      transferTableCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const mergeTablesInput = z.object({
  intoBookingId: z.string().uuid(),
  fromBookingId: z.string().uuid(),
})

/** Fold one table session into another (M17 #5) — every open order from
 *  "from" moves onto "into", cover counts sum, "from" closes and its table
 *  frees up. */
export async function mergeTables(input: z.input<typeof mergeTablesInput>): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    const v = mergeTablesInput.parse(input)
    await withUser(ctx.user.id, (tx) =>
      mergeTablesCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const splitTableInput = z.object({
  sourceBookingId: z.string().uuid(),
  targetResourceId: z.string().uuid(),
  orderIds: z.array(z.string().uuid()),
  coverCount: z.coerce.number().int().positive('Guest count must be at least 1.'),
})

/** Split a subset of a table session's open orders onto a brand-new session
 *  on a different, currently free table (M17 #5) — a second, separate tab
 *  for the same visit. */
export async function splitTable(input: z.input<typeof splitTableInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Table service is not enabled for this business.')
    }
    const v = splitTableInput.parse(input)
    const result = await withUser(ctx.user.id, (tx) =>
      splitTableCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/floor')
    return { bookingId: result.id, bookingNumber: result.bookingNumber }
  } catch (e) {
    return fail(e)
  }
}

type CustomerLookupResult = { found: boolean; name: string | null }

/**
 * Phone-first walk-in flow: staff enter the phone before the name, and if
 * that number already has a customer profile we skip asking for the name at
 * all. Safe to return the stored name here (unlike the public booking site's
 * lookupPublicCustomerByPhone) — the caller is an authenticated staff member
 * who can already see this in the customer directory.
 */
export async function lookupCustomerByPhone(phone: string): Promise<CustomerLookupResult> {
  try {
    const ctx = await requireContext()
    if (!isValidPhone(phone)) return { found: false, name: null }
    const customer = await withUser(ctx.user.id, (tx) => findCustomerByRawPhone(tx, ctx.tenant.id, phone))
    return { found: Boolean(customer), name: customer?.name ?? null }
  } catch {
    return { found: false, name: null }
  }
}

type BookingStatus = 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show'

/**
 * Server action: transition a booking's status, gating 'completed' on a
 * fully-paid bill, refusing 'no_show' for a walk-in (M21 #8 QA pass — see
 * below), and cancelling its open orders on 'cancelled'.
 *
 * `reason` is required for 'cancelled' — re-checked at runtime below (not
 * just in the UI), since this action is the only path (staff or otherwise)
 * that can write the status. Ignored for every other transition. The
 * conditional rest tuple below encodes that same requirement at the type
 * level: calling with the literal 'cancelled' won't compile without a
 * reason, while a caller holding a broader BookingStatus value (not
 * narrowed to a single literal) still gets the optional form, since the
 * runtime check is what actually guards that case.
 */
export async function setBookingStatus<S extends BookingStatus>(
  id: string,
  status: S,
  ...args: S extends 'cancelled' ? [reason: string] : [reason?: string]
): Promise<Result> {
  const reason = args[0]
  try {
    const ctx = await requireContext()
    const now = new Date()
    const set: Partial<typeof bookings.$inferInsert> = { status }
    if (status === 'checked_in') set.checkedInAt = now
    else if (status === 'completed') set.completedAt = now
    else if (status === 'cancelled') {
      const trimmed = reason?.trim()
      if (!trimmed) return { error: 'Please provide a reason for cancelling this booking.' }
      set.cancelledAt = now
      set.cancellationReason = trimmed
    }

    await withUser(ctx.user.id, async (tx) => {
      if (status === 'completed') {
        await assertBookingFullyPaid(tx, ctx.tenant.id, id)
      }

      if (status === 'no_show') {
        // A walk-in is born already `checked_in` (startWalkinCore) — the
        // customer is physically present the moment the booking exists, so
        // "didn't show up" cannot apply. The UI never offers this either
        // (BookingsView's No-show button only shows for a 'confirmed'
        // booking, which a walk-in never is), but hiding a button is
        // convenience, never a guard — the action refuses it too.
        const [row] = await tx
          .select({ channel: bookings.channel })
          .from(bookings)
          .where(and(eq(bookings.id, id), eq(bookings.tenantId, ctx.tenant.id)))
          .limit(1)
        if (row?.channel === 'walkin') {
          throw new BookingError('A walk-in cannot be marked no-show — it is already checked in.')
        }
      }

      await tx.update(bookings).set(set).where(and(eq(bookings.id, id), eq(bookings.tenantId, ctx.tenant.id)))

      // Cancelling a booking must not leave the kitchen cooking for it, or a
      // food order sitting there waiting to be billed for a booking that
      // never happened — same transaction, so the booking and its orders
      // cancel together or not at all.
      if (status === 'cancelled') {
        await cancelOpenOrdersForBooking(tx, { tenantId: ctx.tenant.id }, id)
      }
    })
    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Server action: cancel a booking (thin wrapper over setBookingStatus). */
export async function cancelBooking(id: string, reason: string): Promise<Result> {
  return setBookingStatus(id, 'cancelled', reason)
}

const CONFIRMATION_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A scanned QR encodes the full confirmation URL; a keyboard-wedge scanner
 * or manual paste might supply just the bare token. Either way, the
 * confirmation_token is the only UUID in the string. */
function extractConfirmationToken(raw: string): string | null {
  const match = raw.match(CONFIRMATION_TOKEN_RE)
  return match ? match[0].toLowerCase() : null
}

export type CheckInResult = Result & {
  booking?: {
    bookingNumber: string
    customerName: string | null
    resourceName: string | null
    startsAt: string | null
    alreadyCheckedIn: boolean
  }
}

/**
 * Staff check-in scan (components/bookings/ScanCheckIn.tsx): resolves a
 * booking by its confirmation_token — never by bookingNumber, same
 * unguessable-identifier rule as the public confirmation page (see
 * 0026_booking_confirmation_token.sql) — and transitions it to checked_in,
 * the same status write setBookingStatus above does.
 */
export async function checkInBookingByToken(raw: string): Promise<CheckInResult> {
  try {
    const ctx = await requireContext()
    const token = extractConfirmationToken(raw)
    if (!token) return { error: "That doesn't look like a booking QR code." }

    const result = await withUser(ctx.user.id, async (tx) => {
      const [row] = await tx
        .select({
          id: bookings.id,
          bookingNumber: bookings.bookingNumber,
          customerName: bookings.customerName,
          status: bookings.status,
        })
        .from(bookings)
        .where(and(eq(bookings.tenantId, ctx.tenant.id), eq(bookings.confirmationToken, token)))
        .limit(1)
      if (!row) return null

      const [slot] = await tx
        .select({ resourceName: bookingSlots.resourceName, startsAt: bookingSlots.startsAt })
        .from(bookingSlots)
        .where(and(eq(bookingSlots.tenantId, ctx.tenant.id), eq(bookingSlots.bookingId, row.id)))
        .orderBy(bookingSlots.startsAt)
        .limit(1)

      if (row.status === 'checked_in') {
        return { row, slot, alreadyCheckedIn: true }
      }
      if (row.status !== 'confirmed') {
        throw new BookingError(`This booking is ${row.status.replace('_', ' ')} — it can't be checked in.`)
      }

      await tx
        .update(bookings)
        .set({ status: 'checked_in', checkedInAt: new Date() })
        .where(and(eq(bookings.id, row.id), eq(bookings.tenantId, ctx.tenant.id)))

      return { row, slot, alreadyCheckedIn: false }
    })

    if (!result) return { error: 'No booking found for that code.' }

    revalidatePath('/bookings')
    return {
      booking: {
        bookingNumber: result.row.bookingNumber,
        customerName: result.row.customerName,
        resourceName: result.slot?.resourceName ?? null,
        startsAt: result.slot?.startsAt.toISOString() ?? null,
        alreadyCheckedIn: result.alreadyCheckedIn,
      },
    }
  } catch (e) {
    return fail(e)
  }
}
