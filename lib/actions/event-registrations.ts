'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withCustomer } from '@/db'
import { getCurrentCustomer } from '@/lib/auth/customer-session'
import {
  cancelOwnEventRegistration,
  claimEventRegistration,
  joinEventTeam as joinEventTeamCore,
} from '@/lib/events/registrations'
import { refusalMessage, type EventRegistrationStatus } from '@/lib/events/registration'
import {
  createEventRegistrationPayment,
  createEventRegistrationPaymentInputSchema,
  EventRegistrationPaymentError,
  OrphanedEventRegistrationPaymentError,
  type EventRegistrationCheckout,
} from '@/lib/payments/event-registration-payment'
import { createRazorpayOrder, RazorpayApiError } from '@/lib/payments/razorpay'
import { loadRazorpayCredentialsForTenant } from '@/lib/settings/razorpay-credentials'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'

/**
 * Customer-initiated event registration (M15 #3).
 *
 * The security posture is the one lib/actions/customer-bookings.ts established
 * and this file does not deviate from it:
 *
 *   getCurrentCustomer()      ← httpOnly cookie, validated against
 *                                customer_sessions AND this subdomain
 *        ↓
 *   withCustomer(customer.id) ← RLS narrows every table to that customer
 *        ↓
 *   claim_event_registration()← locks the event, re-checks everything, decides
 *
 * The ONLY inputs that cross the wire are an event id, a team id, a team name
 * and a registration id. No tenant id, no customer id, no price, no capacity
 * and no status: each of those is either derived from the validated session or
 * read from the database inside the locked function. A caller who submits
 * somebody else's registration id gets the same "could not be found" answer as
 * one who submits a UUID that does not exist.
 *
 * ── Why sign-in is required, rather than a guest phone capture ──────────────
 *
 * The public booking flow captures a phone number and finds-or-creates a
 * customer from it, with no proof the caller owns that number. That is
 * acceptable for a booking somebody makes for themselves at a venue they are
 * about to walk into; it is not acceptable here, because the ticket's own rule
 * is that a customer must not be able to register anybody else. A phone field
 * IS a "register anybody else" field. M9's OTP session already exists and
 * already proves the number, so registration uses it and the CTA sends a
 * signed-out visitor to /account/login first.
 */

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'
const SIGN_IN_MESSAGE = 'Please sign in to register for this event.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

/** Refresh every surface a registration changes: the event page and the portal. */
function revalidateRegistrationPaths(eventId: string) {
  revalidatePath(`/events/${eventId}`)
  revalidatePath(`/events/${eventId}/register`)
  revalidatePath('/events')
  revalidatePath('/account/events')
  revalidatePath('/account')
}

// ── register ─────────────────────────────────────────────────────────────────

const registerInput = z.object({
  eventId: z.string().uuid(),
  /**
   * Only meaningful for a team event, and whether it IS one is decided from the
   * event row inside the database — a team name sent for a solo event is a
   * refusal ('not_a_team_event'), not something quietly ignored.
   */
  teamName: z.string().trim().min(1).max(80).optional(),
})

export type RegisterForEventResult = {
  error?: string
  registrationId?: string
  status?: EventRegistrationStatus
  /** True when the entrant now owes an entry fee — the client opens checkout. */
  needsPayment?: boolean
  /** Present for a team event: the team the captain just created. */
  teamId?: string
}

export async function registerForEvent(
  raw: z.input<typeof registerInput>,
): Promise<RegisterForEventResult> {
  const customer = await getCurrentCustomer()
  if (!customer) return { error: SIGN_IN_MESSAGE }

  if (!rateLimit(`event-register:ip:${await callerIp()}`, 15, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }
  // Per customer as well as per IP: a shared office NAT must not lock everyone
  // out, and one account must not be able to hammer the claim function.
  if (!rateLimit(`event-register:customer:${customer.id}`, 10, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const parsed = registerInput.safeParse(raw)
  if (!parsed.success) return { error: 'That event could not be found.' }

  const outcome = await claimEventRegistration(
    customer.id,
    parsed.data.eventId,
    parsed.data.teamName ?? null,
  )
  if (!outcome.ok) return { error: refusalMessage(outcome.refusal) }

  revalidateRegistrationPaths(parsed.data.eventId)

  return {
    registrationId: outcome.registrationId,
    status: outcome.status,
    // Derived from the status the DATABASE chose, not from the fee the browser
    // was shown: a waitlisted entrant owes nothing, and a free event's entrant
    // is already registered.
    needsPayment: outcome.status === 'pending_payment',
    teamId: outcome.teamId ?? undefined,
  }
}

// ── join a team ──────────────────────────────────────────────────────────────

const joinInput = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() })

export async function joinEventTeam(
  raw: z.input<typeof joinInput>,
): Promise<{ error?: string; ok?: true }> {
  const customer = await getCurrentCustomer()
  if (!customer) return { error: SIGN_IN_MESSAGE }

  if (!rateLimit(`event-join:customer:${customer.id}`, 10, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const parsed = joinInput.safeParse(raw)
  if (!parsed.success) return { error: 'That team could not be found.' }

  // `eventId` is used ONLY to revalidate the right page. The team's event is
  // read from the team row inside join_event_team(), so a mismatched pair
  // cannot put anyone in the wrong event.
  const outcome = await joinEventTeamCore(customer.id, parsed.data.teamId)
  if (outcome !== 'joined') return { error: refusalMessage(outcome) }

  revalidateRegistrationPaths(parsed.data.eventId)
  return { ok: true }
}

// ── cancel ───────────────────────────────────────────────────────────────────

const cancelInput = z.object({
  registrationId: z.string().uuid(),
  eventId: z.string().uuid().optional(),
})

export async function cancelMyEventRegistration(
  raw: z.input<typeof cancelInput>,
): Promise<{ error?: string; ok?: true }> {
  const customer = await getCurrentCustomer()
  if (!customer) return { error: SIGN_IN_MESSAGE }

  const parsed = cancelInput.safeParse(raw)
  if (!parsed.success) return { error: 'That registration could not be found.' }

  // Ownership is checked inside cancel_event_registration() against
  // current_customer_id(); this action passes no customer id it could get wrong.
  const outcome = await cancelOwnEventRegistration(customer.id, parsed.data.registrationId)
  if (outcome !== 'cancelled') return { error: refusalMessage(outcome) }

  if (parsed.data.eventId) revalidateRegistrationPaths(parsed.data.eventId)
  else {
    revalidatePath('/account/events')
    revalidatePath('/events')
  }
  return { ok: true }
}

// ── pay ──────────────────────────────────────────────────────────────────────

export type CreateEventRegistrationCheckoutResult = {
  error?: string
  checkout?: EventRegistrationCheckout
}

/** Same narrow-failure discipline as lib/actions/public-orders.ts's failOrderPayment. */
function failPayment(e: unknown): CreateEventRegistrationCheckoutResult {
  if (e instanceof EventRegistrationPaymentError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  if (e instanceof OrphanedEventRegistrationPaymentError) {
    console.error(
      `[event-registrations] intent NOT persisted after gateway order ${e.gatewayOrderId} was created — reconcile this order`,
    )
    return { error: e.message }
  }

  if (e instanceof RazorpayApiError) {
    console.error(`[event-registrations] razorpay order creation failed with status ${e.status}`)
    return {
      error: e.retriable
        ? 'The payment gateway is not responding. Please try again in a moment.'
        : e.message,
    }
  }

  console.error(
    '[event-registrations] createEventRegistrationCheckout failed:',
    e instanceof Error ? e.name : 'unknown',
  )
  return { error: 'Could not start the payment. Please try again.' }
}

/**
 * Open a Razorpay order for the entry fee on a held place.
 *
 * The tenant comes from the customer's validated session, and its credentials
 * are loaded fresh through the same BYO loader booking deposits and order
 * pay-now use — never platform credentials, never a value cached from an
 * earlier call, never anything from the client.
 *
 * Creating a gateway order is NOT taking a payment. The registration stays
 * `pending_payment` and the intent stays `pending`; only the verified webhook
 * moves either.
 */
export async function createEventRegistrationCheckout(
  input: z.input<typeof createEventRegistrationPaymentInputSchema>,
): Promise<CreateEventRegistrationCheckoutResult> {
  try {
    const customer = await getCurrentCustomer()
    if (!customer) return { error: SIGN_IN_MESSAGE }

    if (!rateLimit(`event-pay:customer:${customer.id}`, 8, 10 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
    }

    const v = createEventRegistrationPaymentInputSchema.parse(input)

    const credentials = await loadRazorpayCredentialsForTenant(customer.tenantId)
    if (!credentials) {
      return { error: 'Online payment is not available for this venue right now.' }
    }

    const checkout = await createEventRegistrationPayment(v, {
      runInTx: (fn) => withCustomer(customer.id, fn),
      credentials,
      createOrder: createRazorpayOrder,
      actor: { tenantId: customer.tenantId },
    })

    return { checkout }
  } catch (e) {
    return failPayment(e)
  }
}
