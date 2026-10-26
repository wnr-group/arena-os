'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { bookings, resources } from '@/db/schema'
import { priceAddonRequests, type PricedAddonLine } from '@/lib/booking/addons'
import { resolvePublicTenant } from '@/lib/tenant/public'
import {
  getPublicBranch,
  getPublicAvailableStartsForType,
  getPublicAvailableStarts,
  getPublicDayRangeWindow,
  getPublicAddonAvailability,
  type PublicAddonAvailability,
} from '@/lib/booking/public-availability'
import {
  assertWithinAdvanceWindow,
  createBookingCore,
  priceBookingSlots,
  resolvePublicHeadCount,
  BookingError,
} from '@/lib/booking/service'
import { dayRangeError, horizonMessage, horizonNow, isDateWithinHorizon } from '@/lib/booking/horizon'
import { publicMaxAdvanceDaysOrDefault } from '@/lib/booking/settings-server'
import { assertSlotsOnGrid } from '@/lib/booking/slot-grid'
import { todayInZone } from '@/lib/booking/time'
import { getPublicBookingPaymentState } from '@/lib/booking/public-confirmation'
import { findCustomerByRawPhone } from '@/lib/customers/service'
import { resolveOnlineCharge, OnlineChargeError, PAYMENT_HOLD_MINUTES, type OnlinePaymentPolicy } from '@/lib/booking/online-charge'
import { sweepTenantHolds } from '@/lib/booking/payment-hold'
import { loadOnlinePaymentPolicy } from '@/lib/settings/online-payment-policy'
import { round2 } from '@/lib/billing/pricing'
import { pgError } from '@/lib/utils/errors'
import {
  createBookingPaymentIntent as createBookingPaymentIntentCore,
  createBookingPaymentIntentInputSchema,
  BookingPaymentError,
  OrphanedBookingPaymentError,
  type BookingPaymentCheckout,
} from '@/lib/payments/booking-payment'
import { createRazorpayOrder, RazorpayApiError } from '@/lib/payments/razorpay'
import { loadRazorpayCredentialsForTenant } from '@/lib/settings/razorpay-credentials'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'

/**
 * M37 #2: refuse a date beyond the venue's advance-booking window. Fails closed
 * to 7 days if the setting cannot be read. Returns the error text, or null.
 */
async function publicHorizonError(tenant: { id: string; timezone: string }, dateStr: string): Promise<string | null> {
  const max = await publicMaxAdvanceDaysOrDefault(tenant.id)
  const today = todayInZone(tenant.timezone, horizonNow())
  return isDateWithinHorizon(dateStr, today, max) ? null : horizonMessage(today, max)
}

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

/** Add-on lines a customer picked, as the public pages send them. */
const addonRequestsInput = z
  .array(z.object({ addonId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(20) }))
  .max(20)

/**
 * Price the add-ons for one resource's window and refuse any that aren't
 * attachable to it (unknown / retired / other branch / other resource type) —
 * the same rules attachAddonsToSlots enforces under the lock at booking time,
 * checked up front so a quote and a pay-now deposit never include a line the
 * booking would then refuse.
 */
async function priceResourceAddons(
  tx: Parameters<Parameters<typeof withPublicTenant>[1]>[0],
  tenantId: string,
  branchId: string,
  resourceId: string,
  startsAt: Date,
  endsAt: Date,
  requests: { addonId: string; quantity: number }[],
): Promise<{ lines: PricedAddonLine[]; total: number }> {
  if (requests.length === 0) return { lines: [], total: 0 }
  const [res] = await tx
    .select({ resourceTypeId: resources.resourceTypeId })
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.tenantId, tenantId)))
  const priced = await priceAddonRequests(tx, tenantId, startsAt, endsAt, requests)
  const distinct = new Set(requests.map((r) => r.addonId)).size
  if (
    !res ||
    priced.lines.length !== distinct ||
    priced.lines.some((l) => l.branchId !== branchId || l.resourceTypeId !== res.resourceTypeId)
  ) {
    throw new BookingError('An add-on you selected is no longer available.')
  }
  return priced
}

const availabilityInput = z.object({
  resourceTypeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(30).max(240),
})

export type PublicSlotOption = { startsAt: string; resourceId: string }
export type AvailabilityResult = {
  /** Bookable start times, each with the unit it would be assigned. */
  starts?: PublicSlotOption[]
  /**
   * Every start time the working hours and the chosen duration allow, bookable
   * or not — so the picker can show a whole day and disable what is taken,
   * rather than silently deleting an afternoon. Same contract the
   * single-resource page has had (getPublicResourceAvailability).
   */
  allStarts?: string[]
  /** Venue booking time step (minutes) the start times are laid out on. */
  slotMinutes?: number
  /** M22 #4: the effective hourly rate for the SELECTED date (weekday or
   *  weekend, per lib/booking/rate.ts:resolveDayRate) — the wizard prices its
   *  live estimate/deposit off this instead of a static, date-blind rate, so
   *  the quote never drifts from what createPublicBooking actually charges. */
  rate?: string
  error?: string
}

/** Step 4 of the booking wizard: open start times for one resource type. */
export async function getPublicAvailability(
  raw: z.input<typeof availabilityInput>,
): Promise<AvailabilityResult> {
  // Shares a budget with getPublicResourceAvailability below — both are the
  // same kind of read, just against a type vs. a specific resource, and the
  // wizard only ever calls one family per session.
  if (!rateLimit(`avail:${await callerIp()}`, 40, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = availabilityInput.safeParse(raw)
  if (!v.success) return { error: 'Invalid request.' }
  const beyond = await publicHorizonError(tenant, v.data.date)
  if (beyond) return { error: beyond }


  await sweepTenantHolds(tenant.id)

  const branch = await getPublicBranch(tenant.id)
  if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

  const result = await getPublicAvailableStartsForType({
    tenantId: tenant.id,
    branchId: branch.id,
    resourceTypeId: v.data.resourceTypeId,
    timeZone: tenant.timezone,
    date: v.data.date,
    durationMinutes: v.data.durationMinutes,
  })
  if ('error' in result) return result

  return {
    starts: result.starts.map((s) => ({ startsAt: s.start.toISOString(), resourceId: s.resourceId })),
    allStarts: result.allStarts.map((d) => d.toISOString()),
    slotMinutes: result.slotMinutes,
    rate: result.rate,
  }
}

const resourceAvailabilityInput = z.object({
  resourceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(30).max(240),
})

export type PublicResourceAvailabilityResult =
  | { starts: string[]; allStarts: string[]; slotMinutes: number; isClosed: boolean; rate: string }
  | { error: string }

/** Same as getPublicAvailability, but for one specific resource unit rather
 * than "first free unit of a type" — the resource-booking page books an
 * actual resource, so it needs that resource's own open/closed grid. */
export async function getPublicResourceAvailability(
  raw: z.input<typeof resourceAvailabilityInput>,
): Promise<PublicResourceAvailabilityResult> {
  if (!rateLimit(`avail:${await callerIp()}`, 40, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = resourceAvailabilityInput.safeParse(raw)
  if (!v.success) return { error: 'Invalid request.' }
  const beyond = await publicHorizonError(tenant, v.data.date)
  if (beyond) return { error: beyond }


  await sweepTenantHolds(tenant.id)

  const branch = await getPublicBranch(tenant.id)
  if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

  const result = await getPublicAvailableStarts({
    tenantId: tenant.id,
    branchId: branch.id,
    resourceId: v.data.resourceId,
    timeZone: tenant.timezone,
    date: v.data.date,
    durationMinutes: v.data.durationMinutes,
  })
  if ('error' in result) return result

  return {
    starts: result.starts.map((d) => d.toISOString()),
    allStarts: result.allStarts.map((d) => d.toISOString()),
    slotMinutes: result.slotMinutes,
    isClosed: result.isClosed,
    rate: result.rate,
  }
}

const dayRangeInput = z.object({
  resourceId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export type PublicDayRangeResult = { error?: string; startsAt?: string; endsAt?: string; conflict?: boolean }

/**
 * M24 #5: the public mirror of the staff getDayRangeWindow
 * (lib/actions/availability.ts, M24 #4) — resolves a customer-picked
 * calendar-date range for a per-day setup into the exact "D1 open -> Dn
 * close" instants priceBookingSlots already prices against, plus a soft
 * conflict pre-check. Shares the same `avail:` rate-limit budget as
 * getPublicAvailability/getPublicResourceAvailability above — same kind of
 * read, and the page only ever needs one family per session.
 */
export async function getPublicBookingDayRange(raw: z.input<typeof dayRangeInput>): Promise<PublicDayRangeResult> {
  if (!rateLimit(`avail:${await callerIp()}`, 40, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = dayRangeInput.safeParse(raw)
  if (!v.success) return { error: 'Invalid request.' }
  {
    const max = await publicMaxAdvanceDaysOrDefault(tenant.id)
    const bad = dayRangeError(v.data.startDate, v.data.endDate, todayInZone(tenant.timezone, horizonNow()), max)
    if (bad) return { error: bad }
  }


  await sweepTenantHolds(tenant.id)

  const branch = await getPublicBranch(tenant.id)
  if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

  const result = await getPublicDayRangeWindow(
    tenant.id,
    branch.id,
    v.data.resourceId,
    tenant.timezone,
    v.data.startDate,
    v.data.endDate,
  )
  if ('error' in result) return result
  return result
}

const quoteInput = z.object({
  resourceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  // M24 #5: an optional named setup for this resource — priceBookingSlots
  // re-validates it belongs to this resource/tenant and is active, same as
  // the staff quoteBooking (lib/actions/bookings.ts, M24 #2/#4).
  setupId: z.string().uuid().optional(),
  // M35: optional add-ons — priced server-side so the total shown (and the
  // pay-now amount) always includes exactly what the booking will.
  addons: addonRequestsInput.optional(),
})

export type PublicBookingQuoteResult = {
  error?: string
  /** Everything payable: the room/setup price plus add-ons. */
  total?: number
  /** The room/setup part of `total` (equals `total` when no add-ons). */
  slotTotal?: number
  /** M36 #2: the venue's payment mode and the figures the server will actually
   *  charge — render the payment step from these, never recompute client-side.
   *  chargeNow is what is collected online if payment happens (for the legacy
   *  optional_full mode: the full total, only if the customer opts in);
   *  paymentRequired says whether the booking cannot be placed without it. */
  mode?: OnlinePaymentPolicy['mode']
  paymentRequired?: boolean
  chargeNow?: number
  balanceDue?: number
  addons?: { addonId: string; name: string; quantity: number; rateUnit: 'hour' | 'day'; rate: string; units: number; lineTotal: number }[]
}

/**
 * Happy hours #3: read-only price quote for the SELECTED slot on the public
 * booking pages (ResourceBookingPage.tsx / ResourceTypeBookingPage.tsx) — the
 * exact same priceBookingSlots call createPublicBooking's pay-now deposit
 * (and createBookingCore itself) makes, so the displayed total/deposit can
 * never drift from what actually gets charged.
 *
 * getPublicAvailability's/getPublicResourceAvailability's own `rate` field
 * stays day-level only (weekday/weekend, M22 #4) — happy hours are
 * time-of-day, not date, so they can only be resolved once an exact
 * [startsAt, endsAt) window is chosen; this fills that gap for the two
 * screens that show a REAL, about-to-be-booked total. Mirrors
 * lib/actions/bookings.ts's quoteBooking (Happy hours #2, staff wizard),
 * just under public auth: rate-limited, tenant resolved from the subdomain,
 * and headCount is resolved server-side (resolvePublicHeadCount) rather than
 * trusted from the client — same discipline createPublicBooking itself uses,
 * since a per_head public booking never lets the customer choose a count.
 */
export async function getPublicBookingQuote(raw: z.input<typeof quoteInput>): Promise<PublicBookingQuoteResult> {
  if (!rateLimit(`quote:${await callerIp()}`, 40, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = quoteInput.safeParse(raw)
  if (!v.success) return { error: 'Invalid request.' }
  if (new Date(v.data.endsAt) <= new Date(v.data.startsAt)) {
    return { error: 'That slot is no longer valid — please pick another.' }
  }


  await sweepTenantHolds(tenant.id)

  const branch = await getPublicBranch(tenant.id)
  if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

  try {
    const result = await withPublicTenant(tenant.id, async (tx) => {
      const headCount = await resolvePublicHeadCount(tx, tenant.id, [v.data.resourceId])
      const priced = await priceBookingSlots(tx, { tenantId: tenant.id, timezone: tenant.timezone }, {
        branchId: branch.id,
        slots: [{ resourceId: v.data.resourceId, startsAt: v.data.startsAt, endsAt: v.data.endsAt, setupId: v.data.setupId }],
        headCount,
      })
      // M37 #2: the quote refuses what createPublicBooking would refuse.
      await assertWithinAdvanceWindow(tx, { tenantId: tenant.id, timezone: tenant.timezone }, priced.slots)
      const addons = await priceResourceAddons(
        tx,
        tenant.id,
        branch.id,
        v.data.resourceId,
        new Date(v.data.startsAt),
        new Date(v.data.endsAt),
        v.data.addons ?? [],
      )
      return { priced, addons }
    })
    const slotTotal = result.priced.subtotal
    const total = round2(slotTotal + result.addons.total)
    const policy = await loadOnlinePaymentPolicy(tenant.id)
    const charge = resolveOnlineCharge(policy, total, { payNow: true })
    return {
      total,
      slotTotal,
      mode: policy.mode,
      paymentRequired: policy.mode !== 'optional_full' && charge.required,
      chargeNow: charge.amount,
      balanceDue: charge.balance,
      addons: result.addons.lines.map((l) => ({
        addonId: l.addonId,
        name: l.name,
        quantity: l.quantity,
        rateUnit: l.rateUnit,
        rate: l.rate,
        units: l.units,
        lineTotal: l.lineTotal,
      })),
    }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    return { error: 'Could not price this booking.' }
  }
}

const phoneLookupInput = z.object({
  phone: z.string().trim().min(1),
})

export type PublicCustomerLookupResult = { found: boolean } | { error: string }

/**
 * Peek at the customer directory by phone as the guest types it into the
 * booking form, so the form knows whether this number already has a profile.
 * Deliberately returns only a boolean — never the stored name or any other
 * PII — because this endpoint is unauthenticated and reachable by anyone
 * probing phone numbers on the tenant subdomain; echoing the name back would
 * let a stranger enumerate customers and harvest their identities. Read-only:
 * the actual find-or-create only happens transactionally inside
 * createBookingCore when the booking is confirmed (lib/booking/customer.ts);
 * this never creates a customer by itself.
 */
export async function lookupPublicCustomerByPhone(
  raw: z.input<typeof phoneLookupInput>,
): Promise<PublicCustomerLookupResult> {
  // IP-limited (not per-phone): the risk here is a stranger enumerating many
  // phone numbers looking for hits, not repeated lookups of one number.
  if (!rateLimit(`lookup:${await callerIp()}`, 20, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = phoneLookupInput.safeParse(raw)
  if (!v.success) return { found: false }

  const customer = await withPublicTenant(tenant.id, (tx) => findCustomerByRawPhone(tx, tenant.id, v.data.phone))
  return { found: Boolean(customer) }
}

const bookingInput = z.object({
  resourceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  customerName: z.string().trim().max(100).optional().or(z.literal('')),
  customerPhone: z.string().trim().min(6, 'Enter a valid phone number.').max(20),
  customerEmail: z.string().trim().email('Enter a valid email address.').max(255).optional().or(z.literal('')),
  /** Not a first-class column — the schema has no per-booking player count,
   * so this rides along as a note, same as staff bookings already do. */
  players: z.coerce.number().int().min(1).max(100).optional(),
  /** M14 #8: the customer chose "pay online now" over "pay at the venue".
   *  Only ever charges the booking's OWN total, re-priced server-side below —
   *  never a figure trusted from the client. */
  payNow: z.boolean().optional(),
  // M24 #5: an optional named setup for this resource, re-validated
  // server-side (resource/tenant/active) by priceBookingSlots below, same
  // as quoteInput's setupId above — never trusted further than that.
  setupId: z.string().uuid().optional(),
  /** M35: add-ons for this booking. Re-priced and stock-checked under the
   *  catalog lock server-side; the pay-now deposit includes them. */
  addons: addonRequestsInput.optional(),
  /** Honeypot: a real visitor never sees or fills this field (it's rendered
   * off-screen and excluded from the tab order — see HoneypotField). A
   * non-empty value means whatever submitted the form filled in every input
   * it found, which is a form-filling bot, not a customer. */
  website: z.string().optional(),
})

export type CreatePublicBookingResult = {
  error?: string
  bookingNumber?: string
  confirmationToken?: string
  /** Present on every success — needed to chain into createBookingPaymentIntent. */
  bookingId?: string
  /** True when payNow was honoured — the client must now call createBookingPaymentIntent. */
  awaitingOnlinePayment?: boolean
}

/**
 * Step 6 (confirm) of the booking wizard. Shares createBookingCore with the
 * staff action (lib/actions/bookings.ts) but never trusts the client for
 * branch, source or discount: the branch is resolved server-side from the
 * subdomain, source is hardcoded 'online' (also enforced at the database
 * layer — see 0023_public_booking_create.sql), and discount is always zero —
 * a stranger can never discount their own booking. `deposit` is the one
 * exception: when payNow is set, it is seeded with the booking's OWN total
 * (re-priced here via priceBookingSlots, never trusted from the client) so
 * the booking is created already owing itself in full online — see
 * createBookingPaymentIntent below for the gateway order that actually
 * collects it.
 */
export async function createPublicBooking(
  raw: z.input<typeof bookingInput>,
): Promise<CreatePublicBookingResult> {
  try {
    // This is the action that consumes real inventory (a resource slot) and
    // writes a customer row, so it gets the tightest budget of any public
    // action here, checked before any parsing or DB work.
    if (!rateLimit(`book:ip:${await callerIp()}`, 5, 10 * 60_000).ok) {
      return { error: 'Too many booking attempts. Please wait a bit and try again.' }
    }

    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant

    const v = bookingInput.parse(raw)

    // Bot bait — see the `website` field's doc comment on bookingInput.
    // Fails the same generic way a real validation error would, so a bot
    // reading the response can't tell it was caught by the honeypot.
    if (v.website) {
      return { error: 'Something went wrong. Please try again.' }
    }

    // Per-phone, on top of the per-IP check above: catches a script that
    // rotates IPs but keeps hammering one number (or the reverse — one
    // venue's phone getting flooded from a botnet).
    const phoneDigits = v.customerPhone.replace(/\D/g, '')
    if (phoneDigits && !rateLimit(`book:phone:${phoneDigits}`, 3, 10 * 60_000).ok) {
      return { error: 'Too many booking attempts for this phone number. Please wait a bit and try again.' }
    }

    if (new Date(v.endsAt) <= new Date(v.startsAt)) {
      return { error: 'That slot is no longer valid — please pick another.' }
    }


    await sweepTenantHolds(tenant.id)

    const branch = await getPublicBranch(tenant.id)
    if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

    // The form only collects a name for phone numbers it doesn't already
    // recognise (see lookupPublicCustomerByPhone) — enforce that server-side
    // too, since the client's "already known" state can't be trusted.
    const existingCustomer = await withPublicTenant(tenant.id, (tx) =>
      findCustomerByRawPhone(tx, tenant.id, v.customerPhone),
    )
    if (!existingCustomer && !v.customerName?.trim()) {
      return { error: 'Enter your name.' }
    }

    const slots = [
      { resourceId: v.resourceId, startsAt: v.startsAt, endsAt: v.endsAt, setupId: v.setupId, addons: v.addons },
    ]

    // M21 per-head #5: honor the player count the customer entered online for a
    // per_head resource, so the price AND the deposit reflect the real party
    // (staff can still adjust it at check-in). resolvePublicHeadCount tells us
    // whether a per_head resource is involved (and its min_players floor):
    // undefined → per_resource, where a player count is meaningless, so we pass
    // nothing. Otherwise use the entered count, falling back to the floor when
    // the customer didn't specify one; a count BELOW the floor is rejected with
    // a clear message by priceBookingSlots/createBookingCore below (same guard
    // the staff path uses), rather than silently charging for more.
    const perHeadMin = await withPublicTenant(tenant.id, (tx) =>
      resolvePublicHeadCount(tx, tenant.id, [v.resourceId]),
    )
    const headCount = perHeadMin === undefined ? undefined : (v.players ?? perHeadMin)

    // Online payment (M36 #2). The VENUE's mode decides whether and how much to
    // charge; the client's payNow only matters in the legacy optional_full mode.
    // Priced BEFORE creating the booking so a total too large to take online, or
    // a venue that cannot take payment, refuses cleanly rather than leaving an
    // unpayable booking behind. createBookingCore re-prices independently.
    const policy = await loadOnlinePaymentPolicy(tenant.id)
    let deposit = 0
    let awaitingOnlinePayment = false
    // advance / full: the booking is held but NOT confirmed until the verified
    // webhook says the money landed. Legacy optional_full + payNow keeps today's
    // behaviour (confirmed immediately, deposit unpaid) — never silently changed.
    let pendingPaymentUntil: Date | undefined
    if (policy.mode !== 'venue' && (policy.mode !== 'optional_full' || v.payNow)) {
      const priced = await withPublicTenant(tenant.id, (tx) =>
        priceBookingSlots(tx, { tenantId: tenant.id, timezone: tenant.timezone }, { branchId: branch.id, slots, headCount }),
      )
      const addonPriced = await withPublicTenant(tenant.id, (tx) =>
        priceResourceAddons(
          tx,
          tenant.id,
          branch.id,
          v.resourceId,
          new Date(v.startsAt),
          new Date(v.endsAt),
          v.addons ?? [],
        ),
      )
      const rupees = round2(priced.subtotal + addonPriced.total)
      // Legacy pay-now keeps refusing a zero total; in the new modes a free
      // booking simply has nothing to collect.
      if (policy.mode === 'optional_full' && !(rupees > 0)) {
        return { error: 'This booking has nothing to pay for.' }
      }
      let charge
      try {
        charge = resolveOnlineCharge(policy, rupees, { payNow: v.payNow })
      } catch (e) {
        if (e instanceof OnlineChargeError) return { error: e.message }
        throw e
      }
      if (charge.amount > 0) {
        // Fail closed: never create a booking that owes money the venue cannot
        // collect (credentials cleared out-of-band or no longer decryptable).
        const credentials = await loadRazorpayCredentialsForTenant(tenant.id).catch((e) => {
          console.error('[public-booking] loadRazorpayCredentialsForTenant failed:', e instanceof Error ? e.name : 'unknown')
          return null
        })
        if (!credentials) return { error: 'Online payment is not available for this venue right now.' }
        deposit = charge.amount
        awaitingOnlinePayment = true
        if (policy.mode === 'advance' || policy.mode === 'full') {
          pendingPaymentUntil = new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000)
        }
      }
    }

    const result = await withPublicTenant(tenant.id, async (tx) => {
      await assertSlotsOnGrid(tx, { tenantId: tenant.id, timezone: tenant.timezone }, branch.id, slots)
      return createBookingCore(
        tx,
        { tenantId: tenant.id, timezone: tenant.timezone, membershipId: null },
        {
          branchId: branch.id,
          customerName: v.customerName || undefined,
          customerPhone: v.customerPhone,
          customerEmail: v.customerEmail || undefined,
          notes: v.players ? `Players: ${v.players}` : undefined,
          source: 'online',
          discount: 0,
          deposit,
          slots,
          headCount,
          pendingPaymentUntil,
        },
      )
    })

    revalidatePath('/bookings')
    return {
      bookingNumber: result.bookingNumber,
      confirmationToken: result.confirmationToken,
      bookingId: result.id,
      awaitingOnlinePayment,
    }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    // 23P01 = exclusion_violation: someone else took this slot first.
    // Drizzle wraps the real driver error (and its SQLSTATE) several levels
    // deep in `.cause` — a shallow `'code' in e` check never actually
    // matches a genuine constraint violation, silently falling through to
    // the raw "Failed query: insert into ..." message below instead. Use
    // the same pgError() unwrapping the staff bookings action already
    // relies on (lib/actions/bookings.ts's fail()) rather than duplicating
    // (and under-testing) a second, shallower copy of this check.
    if (pgError(e).code === '23P01') {
      return { error: 'That time was just taken. Please pick another slot.' }
    }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

/* ── M14 #8: pay online at booking time ──────────────────────────────────── */

export type CreateBookingPaymentIntentResult = { error?: string; checkout?: BookingPaymentCheckout }

/** Same narrow-failure discipline as lib/actions/public-orders.ts's failOrderPayment. */
function failBookingPayment(e: unknown): CreateBookingPaymentIntentResult {
  if (e instanceof BookingPaymentError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  if (e instanceof OrphanedBookingPaymentError) {
    console.error(
      `[public-booking] booking-payment intent NOT persisted after gateway order ${e.gatewayOrderId} was created — reconcile this booking`,
    )
    return { error: e.message }
  }

  if (e instanceof RazorpayApiError) {
    console.error(`[public-booking] razorpay order creation failed with status ${e.status}`)
    return {
      error: e.retriable
        ? 'The payment gateway is not responding. Please try again in a moment.'
        : e.message,
    }
  }

  console.error('[public-booking] createBookingPaymentIntent failed:', e instanceof Error ? e.name : 'unknown')
  return { error: 'Could not start the payment. Please try again.' }
}

/**
 * Open a Razorpay order for a just-placed booking's full online prepayment.
 *
 * The client sends only a booking id. Credentials are loaded fresh for this
 * tenant (never cached, never trusted from the client); a tenant with no
 * Razorpay configured returns a friendly error rather than throwing — the
 * booking pages proactively hide "pay online now" when the same loader
 * returns null server-side, so this is the belt-and-braces path, not the
 * expected one.
 */
export async function createBookingPaymentIntent(
  input: z.input<typeof createBookingPaymentIntentInputSchema>,
): Promise<CreateBookingPaymentIntentResult> {
  try {
    if (!rateLimit(`book-pay:ip:${await callerIp()}`, 8, 10 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
    }

    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant

    const v = createBookingPaymentIntentInputSchema.parse(input)

    const credentials = await loadRazorpayCredentialsForTenant(tenant.id)
    if (!credentials) {
      return { error: 'Online payment is not available for this venue right now.' }
    }

    const checkout = await createBookingPaymentIntentCore(v, {
      runInTx: (fn) => withPublicTenant(tenant.id, fn),
      credentials,
      createOrder: createRazorpayOrder,
      actor: { tenantId: tenant.id },
    })

    return { checkout }
  } catch (e) {
    return failBookingPayment(e)
  }
}

const tokenIntentInput = z.object({ token: z.string().uuid() })

/**
 * Retry payment from the confirmation page (M36 #5). The browser only knows the
 * booking's confirmation token (the unguessable /b/[token] handle), so the id is
 * resolved server-side; everything after that is exactly createBookingPaymentIntent
 * — which REUSES the booking's pending intent, so a retry never creates a second
 * order or a second booking, and refuses once the hold has expired.
 */
export async function createBookingPaymentIntentByToken(
  raw: z.input<typeof tokenIntentInput>,
): Promise<CreateBookingPaymentIntentResult> {
  try {
    if (!rateLimit(`book-pay-retry:ip:${await callerIp()}`, 12, 10 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
    }
    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant
    const v = tokenIntentInput.safeParse(raw)
    if (!v.success) return { error: 'That booking link is not valid.' }
    await sweepTenantHolds(tenant.id)
    const found = await withPublicTenant(tenant.id, (tx) =>
      tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.tenantId, tenant.id), eq(bookings.confirmationToken, v.data.token)))
        .limit(1),
    )
    if (!found[0]) return { error: 'Booking not found.' }
    return await createBookingPaymentIntent({ bookingId: found[0].id })
  } catch (e) {
    return failBookingPayment(e)
  }
}

const addonAvailabilityInput = z.object({
  resourceTypeId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
})

/** Longest window the picker may ask about (a multi-day studio hire). */
const ADDON_WINDOW_MAX_MS = 31 * 24 * 60 * 60_000

export type PublicAddonAvailabilityResult = { addons: PublicAddonAvailability[] } | { error: string }

/**
 * M35 #2: live add-on stock for the chosen booking window — what the booking
 * page's add-on picker renders. Anonymous and runs a stock query per call, so
 * it has its own tighter rate-limit budget. Exposes only a capped
 * `available` count, never total stock.
 */
export async function getPublicAddonAvailabilityForWindow(
  raw: z.input<typeof addonAvailabilityInput>,
): Promise<PublicAddonAvailabilityResult> {
  if (!rateLimit(`addons:${await callerIp()}`, 30, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = addonAvailabilityInput.safeParse(raw)
  if (!v.success) return { error: 'Invalid request.' }
  const startsAt = new Date(v.data.startsAt)
  const endsAt = new Date(v.data.endsAt)
  if (endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > ADDON_WINDOW_MAX_MS) {
    return { error: 'That slot is no longer valid — please pick another.' }
  }


  await sweepTenantHolds(tenant.id)

  const branch = await getPublicBranch(tenant.id)
  if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

  return { addons: await getPublicAddonAvailability(tenant.id, branch.id, [v.data.resourceTypeId], startsAt, endsAt) }
}

/**
 * Has this booking's deposit settled yet? (0129)
 *
 * Polled by WhatsappGroupRedirect while a just-paid booking waits for
 * Razorpay's webhook. See getPublicBookingPaymentState() for why a second look
 * is needed at all: the confirmation page renders before the webhook lands, so
 * the answer it computed is almost always stale for an online payment.
 *
 * ── What a caller can learn from this ──────────────────────────────────────
 *
 * One boolean, about a booking they already hold the confirmation token for —
 * the same token that renders the whole confirmation page, so this exposes
 * strictly less than the page it sits on. The token is a capability: unguessable
 * (a v4 uuid, see 0026) and never derived from the sequential booking number.
 *
 * Tenant comes from the subdomain via resolvePublicTenant(), never from the
 * caller, and the read is pinned to it — so a token from venue A cannot be
 * resolved against venue B.
 *
 * Rate-limited per IP because it is polled and public. The budget is generous
 * enough for the real client (one call every 2.5s for at most a minute) and far
 * too small to enumerate anything — which it could not do anyway, the token
 * space being what it is.
 */
export async function getBookingPaymentState(
  token: string,
): Promise<{ awaitingPayment: boolean } | { error: string }> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      return { error: 'Unknown booking.' }
    }
    if (!rateLimit(`paystate:ip:${await callerIp()}`, 60, 5 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
    }

    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant

    const state = await getPublicBookingPaymentState(tenant.id, token)
    // Same answer for "no such booking" and "not this venue's booking".
    if (!state) return { error: 'Unknown booking.' }
    return state
  } catch {
    // Never surfaces a driver message to a public caller. The client treats any
    // error as "still waiting", which is the safe direction: it means the
    // countdown stays unarmed rather than firing on a guess.
    return { error: 'Could not check the payment status.' }
  }
}
