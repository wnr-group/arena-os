import 'server-only'
import { RazorpayApiError } from '@/lib/payments/razorpay'
import type { PlatformRazorpayCredentials } from './credentials'

/**
 * Minimal Razorpay REST client for the SUBSCRIPTIONS API — the platform's own
 * merchant account charging businesses for Arena OS.
 *
 * Sibling of lib/payments/razorpay.ts, which speaks the ORDERS API on a
 * tenant's own account for booking deposits. Same shape, same rules, same error
 * type (RazorpayApiError is reused rather than re-invented) — but a separate
 * module, because they are different endpoints on different accounts serving
 * different money flows, and one file that could do both is one file that could
 * do the wrong one.
 *
 * The project has no Razorpay SDK dependency, so this calls the API with
 * `fetch` exactly as its sibling does.
 *
 * ── Security rules this module keeps ────────────────────────────────────────
 *   * Server-only. The key secret builds an Authorization header and never
 *     leaves these functions.
 *   * Nothing here logs a credential. RazorpayApiError carries a sanitised
 *     message and an HTTP status, never headers or a request body.
 *   * This module does NO money arithmetic and takes NO amount. A Razorpay
 *     plan object already carries its own price; the caller's job is to name
 *     the RIGHT plan id, and verifyPlanPrice() below is how it proves it did.
 *
 * ── Every call is a SEAM ────────────────────────────────────────────────────
 * Each exported function has a matching `…Fn` type, and subscribe.ts takes them
 * as injectable parameters. A real HTTP call to Razorpay has no place in a test
 * suite, and the lifecycle logic is the part actually worth testing.
 */

const API = 'https://api.razorpay.com/v1'
const REQUEST_TIMEOUT_MS = 15_000
/** Razorpay allows at most 15 notes keys, each a string. */
const MAX_NOTES_KEYS = 15

/** HTTP Basic: key id as username, key secret as password. Built inline, never stored. */
function authHeader(credentials: PlatformRazorpayCredentials): string {
  const raw = `${credentials.keyId}:${credentials.keySecret}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

type RazorpayErrorBody = { error?: { code?: unknown; description?: unknown } }

/**
 * One request, with the whole error vocabulary in a single place.
 *
 * Returns the parsed JSON body on success. Throws RazorpayApiError otherwise,
 * with `retriable` distinguishing "come back later" (timeout, 5xx, 429) from
 * "this request is wrong" (4xx) — which is what decides whether a UI offers a
 * retry and whether an action rolls back or waits.
 */
async function request<T>(
  credentials: PlatformRazorpayCredentials,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  /** Extra request headers. Only ever non-secret protocol headers — see refunds. */
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: authHeader(credentials),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    // A timeout or a DNS/TLS failure. The object may or may not exist at
    // Razorpay's end — the caller must treat this as UNKNOWN, and it never
    // means "subscribed".
    throw new RazorpayApiError('Could not reach the payment gateway.', 0, true)
  }

  if (!response.ok) {
    let description = ''
    let code = ''
    try {
      const parsed = (await response.json()) as RazorpayErrorBody
      if (typeof parsed?.error?.description === 'string') description = parsed.error.description
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code
    } catch {
      /* non-JSON error body; the status alone will have to do */
    }

    if (response.status === 401 || response.status === 403) {
      // Never echo Razorpay's auth text — it can name the key id.
      throw new RazorpayApiError(
        'The payment gateway rejected the Arena OS platform credentials.',
        response.status,
        false,
      )
    }

    const retriable = response.status >= 500 || response.status === 429
    // Gateway-authored text about OUR request. It never contains a credential,
    // but it is still not ours, so it is length-capped before it can reach a
    // log or a UI.
    const detail = description ? ` (${description.slice(0, 200)})` : ''
    const error = new RazorpayApiError(
      `The payment gateway rejected the request${detail}.`,
      response.status,
      retriable,
    )
    // Stashed so the customer path can recognise "already exists" without
    // parsing an English sentence at the call site.
    ;(error as RazorpayApiError & { gatewayCode?: string; gatewayDescription?: string }).gatewayCode =
      code
    ;(
      error as RazorpayApiError & { gatewayCode?: string; gatewayDescription?: string }
    ).gatewayDescription = description
    throw error
  }

  return (await response.json()) as T
}

function assertNotes(notes: Record<string, string> | undefined): void {
  if (notes && Object.keys(notes).length > MAX_NOTES_KEYS) {
    throw new RazorpayApiError(`Notes may hold at most ${MAX_NOTES_KEYS} keys.`, 0, false)
  }
}

// ── plans ────────────────────────────────────────────────────────────────────

/**
 * A Razorpay Subscription plan, as this module cares about it.
 *
 * The price lives in `item`, in the smallest currency unit. That is the whole
 * reason this fetch exists: it is how the server checks that the plan id an
 * operator pasted into the Arena OS catalogue really charges the price the
 * Arena OS catalogue advertises.
 */
export type RazorpayPlan = {
  id: string
  period: string
  interval: number
  item: { amount: number; currency: string; name?: string }
}

export type FetchPlanFn = (
  credentials: PlatformRazorpayCredentials,
  planId: string,
) => Promise<RazorpayPlan>

export const fetchRazorpayPlan: FetchPlanFn = async (credentials, planId) => {
  const plan = await request<Partial<RazorpayPlan>>(
    credentials,
    'GET',
    `/plans/${encodeURIComponent(planId)}`,
  )
  if (typeof plan.id !== 'string' || !plan.id) {
    throw new RazorpayApiError('The payment gateway returned an unusable plan.', 200, true)
  }
  const item = plan.item
  if (!item || typeof item.amount !== 'number' || typeof item.currency !== 'string') {
    throw new RazorpayApiError('The payment gateway returned a plan with no price.', 200, false)
  }
  return {
    id: plan.id,
    period: typeof plan.period === 'string' ? plan.period : '',
    interval: typeof plan.interval === 'number' ? plan.interval : 1,
    item: { amount: item.amount, currency: item.currency, name: item.name },
  }
}

// ── customers ────────────────────────────────────────────────────────────────

export type RazorpayCustomer = { id: string; email: string | null }

export type CreateCustomerParams = {
  /** The BUSINESS's name — Arena OS's customer is the venue, not a booker. */
  name: string
  email: string
  contact?: string
  notes?: Record<string, string>
}

export type CreateCustomerFn = (
  credentials: PlatformRazorpayCredentials,
  params: CreateCustomerParams,
) => Promise<RazorpayCustomer>

/**
 * Create the Razorpay customer for a tenant, tolerating the one it already has.
 *
 * Razorpay refuses a duplicate email with `BAD_REQUEST_ERROR` / "Customer
 * already exists for the merchant". `fail_existing: '0'` asks it to return the
 * existing customer instead of erroring, which makes this call idempotent —
 * important because a tenant that abandons checkout and comes back must not
 * accumulate customer objects on the platform account.
 */
export const createRazorpayCustomer: CreateCustomerFn = async (credentials, params) => {
  assertNotes(params.notes)
  const customer = await request<Partial<RazorpayCustomer>>(credentials, 'POST', '/customers', {
    name: params.name.slice(0, 50),
    email: params.email,
    ...(params.contact ? { contact: params.contact } : {}),
    // Return the existing customer rather than 400ing on a repeat email.
    fail_existing: '0',
    ...(params.notes ? { notes: params.notes } : {}),
  })

  if (typeof customer.id !== 'string' || !customer.id) {
    throw new RazorpayApiError('The payment gateway returned an unusable customer.', 200, true)
  }
  return { id: customer.id, email: typeof customer.email === 'string' ? customer.email : null }
}

// ── subscriptions ────────────────────────────────────────────────────────────

/**
 * The slice of Razorpay's subscription entity this application relies on.
 *
 * `current_start` / `current_end` are UNIX SECONDS and are null until the
 * subscription has been authenticated. They are the provider's ABSOLUTE view of
 * the billing period, which is exactly what makes webhook processing idempotent
 * — see lib/platform/billing/lifecycle.ts.
 */
export type RazorpaySubscription = {
  id: string
  plan_id: string
  customer_id: string | null
  status: string
  current_start: number | null
  current_end: number | null
  charge_at: number | null
  /** The hosted page where the payer authorises the mandate. Not a secret. */
  short_url: string | null
  paid_count: number | null
  total_count: number | null
}

export type CreateSubscriptionParams = {
  /** The Razorpay plan id chosen by the SERVER from the Arena OS catalogue. */
  planId: string
  customerId: string
  /**
   * How many billing cycles to authorise. Razorpay requires a finite count, so
   * "until cancelled" is expressed as a long horizon and re-subscribed later.
   */
  totalCount: number
  /** Non-secret key/value pairs echoed back on the webhook. NEVER read for authorization. */
  notes?: Record<string, string>
}

export type CreateSubscriptionFn = (
  credentials: PlatformRazorpayCredentials,
  params: CreateSubscriptionParams,
) => Promise<RazorpaySubscription>

function normaliseSubscription(raw: Partial<RazorpaySubscription>): RazorpaySubscription {
  if (typeof raw.id !== 'string' || !raw.id) {
    throw new RazorpayApiError('The payment gateway returned an unusable subscription.', 200, true)
  }
  if (typeof raw.plan_id !== 'string' || !raw.plan_id) {
    throw new RazorpayApiError(
      'The payment gateway returned a subscription with no plan.',
      200,
      false,
    )
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    id: raw.id,
    plan_id: raw.plan_id,
    customer_id: typeof raw.customer_id === 'string' ? raw.customer_id : null,
    status: typeof raw.status === 'string' ? raw.status : 'created',
    current_start: num(raw.current_start),
    current_end: num(raw.current_end),
    charge_at: num(raw.charge_at),
    short_url: typeof raw.short_url === 'string' ? raw.short_url : null,
    paid_count: num(raw.paid_count),
    total_count: num(raw.total_count),
  }
}

/**
 * Create a subscription on the PLATFORM's Razorpay account.
 *
 * No amount is sent, and that is deliberate: the price is a property of the
 * plan object at Razorpay, so there is no figure here for a caller — or a
 * client — to influence. The only thing that decides what a tenant pays is
 * WHICH plan id the server looked up, and subscribe.ts is where that choice
 * is made and checked.
 *
 * The returned subscription is verified to be for the plan we asked for.
 * Razorpay has never been observed to substitute one, but charging a business
 * on a plan we did not choose is not a failure mode worth trusting away.
 */
export const createRazorpaySubscription: CreateSubscriptionFn = async (credentials, params) => {
  assertNotes(params.notes)
  if (!Number.isSafeInteger(params.totalCount) || params.totalCount <= 0) {
    throw new RazorpayApiError('Subscription cycle count must be a positive integer.', 0, false)
  }

  const raw = await request<Partial<RazorpaySubscription>>(
    credentials,
    'POST',
    '/subscriptions',
    {
      plan_id: params.planId,
      customer_id: params.customerId,
      total_count: params.totalCount,
      quantity: 1,
      // Razorpay emails/SMSes the payer the authorisation link.
      customer_notify: 1,
      ...(params.notes ? { notes: params.notes } : {}),
    },
  )

  const subscription = normaliseSubscription(raw)
  if (subscription.plan_id !== params.planId) {
    throw new RazorpayApiError(
      'The payment gateway returned a subscription for a different plan.',
      200,
      false,
    )
  }
  return subscription
}

export type FetchSubscriptionFn = (
  credentials: PlatformRazorpayCredentials,
  subscriptionId: string,
) => Promise<RazorpaySubscription>

export const fetchRazorpaySubscription: FetchSubscriptionFn = async (
  credentials,
  subscriptionId,
) =>
  normaliseSubscription(
    await request<Partial<RazorpaySubscription>>(
      credentials,
      'GET',
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    ),
  )

export type CancelSubscriptionFn = (
  credentials: PlatformRazorpayCredentials,
  subscriptionId: string,
  atCycleEnd: boolean,
) => Promise<RazorpaySubscription>

/**
 * Cancel a subscription at Razorpay.
 *
 * `atCycleEnd` maps to Razorpay's `cancel_at_cycle_end`. Razorpay only accepts
 * `1` for a subscription that is currently active — a subscription that was
 * never authenticated has no cycle to run out — so the caller
 * (lib/actions/subscription.ts) decides which of the two to ask for based on
 * the LOCAL status, and documents that rule.
 *
 * Whatever this returns, the local row is not treated as finally cancelled
 * until the `subscription.cancelled` webhook confirms it. Provider state is the
 * source of truth, and a browser round-trip is not the provider.
 */
export const cancelRazorpaySubscription: CancelSubscriptionFn = async (
  credentials,
  subscriptionId,
  atCycleEnd,
) =>
  normaliseSubscription(
    await request<Partial<RazorpaySubscription>>(
      credentials,
      'POST',
      `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
    ),
  )

// ── refunds ──────────────────────────────────────────────────────────────────

/**
 * The slice of Razorpay's refund entity this application relies on.
 *
 * `status` is Razorpay's own: `pending` while it works, `processed` once the
 * money has left, `failed` if it could not. It is copied verbatim into
 * platform_refunds.status, which uses the identical three words on purpose —
 * translating a provider's vocabulary into a private one is how two systems
 * end up disagreeing about whether money moved.
 */
export type RazorpayRefund = {
  id: string
  payment_id: string | null
  /** Smallest currency unit, as Razorpay always reports money. */
  amount: number
  currency: string | null
  status: string
}

export type RefundPaymentParams = {
  /** The Razorpay payment (`pay_…`) taken from OUR OWN invoice row. */
  paymentId: string
  /** PAISE, computed by the caller from trusted data. This module does no arithmetic. */
  amountPaise: number
  /**
   * Razorpay's own idempotency header value. The same key returns the SAME
   * refund object instead of creating a second one, which is what makes a
   * retried call safe at the gateway as well as in our database.
   */
  idempotencyKey?: string
  notes?: Record<string, string>
}

export type RefundPaymentFn = (
  credentials: PlatformRazorpayCredentials,
  params: RefundPaymentParams,
) => Promise<RazorpayRefund>

/**
 * Refund part or all of a payment on the PLATFORM's Razorpay account.
 *
 * ── Extending this module rather than writing a second client ──────────────
 *
 * lib/payments/razorpay.ts says in its own header: "If AROS-50 or later work
 * needs refunds, payment fetches or settlements, extend this module rather than
 * calling the API from elsewhere." That instruction is followed here, on the
 * PLATFORM sibling — because this refunds Arena OS's own charge to a business,
 * not a venue's charge to its customer. The two accounts must never cross
 * (0071), so the refund lives beside the subscription calls that created the
 * payment, sharing their credentials type, their `request()` and their error
 * vocabulary.
 *
 * ── The amount is the CALLER's, and it is in paise ─────────────────────────
 *
 * Deliberately, and identically to createRazorpayOrder(): the caller computes
 * it from the locked invoice row and the sum of prior refunds, so there is no
 * arithmetic here to get wrong and nothing a client could influence. A partial
 * refund is an explicit amount; Razorpay refunds the whole payment if none is
 * sent, which is why one is ALWAYS sent.
 *
 * `speed: 'normal'` is the default and the cheap one. `optimum` costs the
 * merchant extra and is not something an operator should trigger by accident
 * from an admin button.
 */
export const refundRazorpayPayment: RefundPaymentFn = async (credentials, params) => {
  assertNotes(params.notes)
  if (!Number.isSafeInteger(params.amountPaise) || params.amountPaise <= 0) {
    throw new RazorpayApiError('Refund amount must be a positive whole number of paise.', 0, false)
  }

  const raw = await request<Partial<RazorpayRefund>>(
    credentials,
    'POST',
    `/payments/${encodeURIComponent(params.paymentId)}/refund`,
    {
      amount: params.amountPaise,
      speed: 'normal',
      ...(params.notes ? { notes: params.notes } : {}),
    },
    params.idempotencyKey ? { 'X-Razorpay-Idempotency-Key': params.idempotencyKey } : undefined,
  )

  if (typeof raw.id !== 'string' || !raw.id) {
    // No refund id means we cannot record WHICH refund this was, and therefore
    // cannot recognise its webhook or refuse a duplicate. Retriable, because
    // the refund may well have been created and a re-read would find it.
    throw new RazorpayApiError('The payment gateway returned an unusable refund.', 200, true)
  }

  return {
    id: raw.id,
    payment_id: typeof raw.payment_id === 'string' ? raw.payment_id : null,
    amount: typeof raw.amount === 'number' ? raw.amount : params.amountPaise,
    currency: typeof raw.currency === 'string' ? raw.currency : null,
    // Absent status is treated as 'pending', never as 'processed'. Assuming the
    // money has left on the strength of a missing field is the one guess that
    // could not be undone.
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'pending',
  }
}

/** The gateway code Razorpay uses when a customer email is already registered. */
export function gatewayErrorDescription(e: unknown): string {
  const err = e as { gatewayDescription?: unknown }
  return typeof err?.gatewayDescription === 'string' ? err.gatewayDescription : ''
}
