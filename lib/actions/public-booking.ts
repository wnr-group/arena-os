'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { withPublicTenant } from '@/db'
import { resolvePublicTenant } from '@/lib/tenant/public'
import { getPublicBranch, getPublicAvailableStartsForType, getPublicAvailableStarts } from '@/lib/booking/public-availability'
import { getPublicBookingPaymentState } from '@/lib/booking/public-confirmation'
import { createBookingCore, priceBookingSlots, BookingError } from '@/lib/booking/service'
import { findCustomerByRawPhone } from '@/lib/customers/service'
import { MAX_PAYMENT_AMOUNT, paise } from '@/lib/billing/payments'
import { round2 } from '@/lib/billing/pricing'
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

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

const availabilityInput = z.object({
  resourceTypeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(30).max(240),
})

export type PublicSlotOption = { startsAt: string; resourceId: string }
export type AvailabilityResult = { starts?: PublicSlotOption[]; error?: string }

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

  return { starts: result.starts.map((s) => ({ startsAt: s.start.toISOString(), resourceId: s.resourceId })) }
}

const resourceAvailabilityInput = z.object({
  resourceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(30).max(240),
})

export type PublicResourceAvailabilityResult =
  | { starts: string[]; allStarts: string[]; isClosed: boolean }
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
    isClosed: result.isClosed,
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

    const slots = [{ resourceId: v.resourceId, startsAt: v.startsAt, endsAt: v.endsAt }]

    // Pay-now: price the slot BEFORE creating the booking, so a total too
    // large to take online refuses cleanly rather than leaving a booking
    // behind that can never be paid through this path. Re-priced again
    // inside createBookingCore itself moments later — this is a preview for
    // the deposit figure, never the value actually written without a second,
    // independent computation.
    let deposit = 0
    if (v.payNow) {
      const priced = await withPublicTenant(tenant.id, (tx) =>
        priceBookingSlots(tx, { tenantId: tenant.id }, { branchId: branch.id, slots }),
      )
      const rupees = round2(priced.subtotal)
      const amountPaise = paise(rupees)
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        return { error: 'This booking has nothing to pay for.' }
      }
      if (rupees > MAX_PAYMENT_AMOUNT) {
        return { error: 'This booking total is too large to pay online.' }
      }
      deposit = rupees
    }

    const result = await withPublicTenant(tenant.id, (tx) =>
      createBookingCore(
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
        },
      ),
    )

    revalidatePath('/bookings')
    return {
      bookingNumber: result.bookingNumber,
      confirmationToken: result.confirmationToken,
      bookingId: result.id,
      awaitingOnlinePayment: Boolean(v.payNow),
    }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    // 23P01 = exclusion_violation: someone else took this slot first.
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23P01') {
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

/**
 * Has this booking's deposit settled yet? (0107)
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
