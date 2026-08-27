'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { menuItems, orders } from '@/db/schema'
import { resolvePublicTenant } from '@/lib/tenant/public'
import { getPublicStation, getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicBookingForOrder } from '@/lib/booking/public-confirmation'
import { createOrderCore, OrderError } from '@/lib/orders/service'
import { getOrderSettingsCore } from '@/lib/orders/settings'
import { findCustomerByRawPhone, findOrCreateCustomer, setNotifyOrderReady } from '@/lib/customers/service'
import {
  createOrderPaymentIntent as createOrderPaymentIntentCore,
  createOrderPaymentIntentInputSchema,
  OrderPaymentError,
  OrphanedOrderPaymentError,
  type OrderPaymentCheckout,
} from '@/lib/payments/order-payment'
import { createRazorpayOrder, RazorpayApiError } from '@/lib/payments/razorpay'
import { loadRazorpayCredentialsForTenant } from '@/lib/settings/razorpay-credentials'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

const orderInput = z.object({
  // Present when the customer scanned a station's QR code; absent when
  // ordering from the homepage/food-menu without a table — that order is
  // placed as a pickup/takeaway order tied only to the tenant's branch.
  stationToken: z.string().uuid().optional(),
  // Present when this order was placed via the "Add food to your visit"
  // nudge on the booking confirmation page (no station/table involved) — see
  // getPublicBookingForOrder. Attaches the order straight to that booking so
  // it lands on the same bill and is visible to staff against it, instead of
  // sitting as an unlinked standalone order.
  bookingToken: z.string().uuid().optional(),
  /**
   * Idempotency (migration 0058) — generated once by CheckoutClient per
   * checkout attempt and reused verbatim on any retry of that SAME attempt
   * (a network retry, or an impatient double-tap on "Place order"). Lets
   * createOrderCore recognise a retry and hand back the original order
   * instead of creating — and cooking — a second one.
   */
  idempotencyKey: z.string().uuid(),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        qty: z.coerce.number().int().min(1).max(20),
        specialInstructions: z.string().trim().max(300).optional(),
      }),
    )
    .min(1, 'Add at least one item')
    .max(30),
  // Same phone-first identification as createPublicBooking (lib/actions/
  // public-booking.ts): name is only required for a phone the directory
  // doesn't already recognise — enforced again below, since the client's
  // "already known" state can't be trusted.
  customerName: z.string().trim().max(100).optional().or(z.literal('')),
  customerPhone: z.string().trim().min(6, 'Enter a valid phone number.').max(20),
  customerEmail: z.string().trim().email('Enter a valid email address.').max(255).optional().or(z.literal('')),
  /** Honeypot — see HoneypotField. A non-empty value means whatever
   *  submitted this filled in every input it found, not a customer. */
  website: z.string().optional(),
  /**
   * M14 #6 (v2): the customer chose "pay online now" over "pay at pickup".
   * Only honoured when the order turns out to be STANDALONE (see the
   * `standalone` check below, re-derived server-side) — a table with an open
   * booking always goes through add-to-bill instead, whatever this says.
   */
  payNow: z.boolean().optional(),
  /** M14 #7 (v2): opt-in for the "order ready" text — checked by default at
   *  checkout, persisted per-customer (see setNotifyOrderReady). */
  notifyOrderReady: z.boolean().optional().default(true),
})

export type PlaceOnlineOrderResult = {
  error?: string
  orderNumber?: string
  /** Present on every success — needed to chain into createOrderPaymentIntent. */
  orderId?: string
  pendingAcceptance?: boolean
  /** True when this order is sitting at acceptanceStatus='awaiting_payment' — the caller must now call createOrderPaymentIntent. */
  awaitingPayment?: boolean
}

/**
 * Re-checks whether a booking the cart attached to earlier (the "Add food to
 * your visit" nudge, cached client-side in OrderCartProvider/localStorage for
 * up to a day — see CartBooking) is still active. The customer may sit on
 * /food-menu or /checkout long after staff completed, cancelled or no-showed
 * the booking; without this the checkout page keeps confidently showing
 * "this will be added to booking #X" for a booking that no longer accepts
 * orders. CheckoutClient calls this on mount and drops the cached attachment
 * (falling back to a plain pickup order) when it comes back false. This is
 * only ever a UI freshness check — createOrderCore re-validates the same
 * ACTIVE_BOOKING_STATUSES gate, inside the actual order transaction, as the
 * authoritative rule.
 */
export async function checkBookingStillActive(bookingToken: string): Promise<{ active: boolean }> {
  const parsed = z.string().uuid().safeParse(bookingToken)
  if (!parsed.success) return { active: false }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return { active: false }

  const booking = await getPublicBookingForOrder(tenant.id, parsed.data)
  return { active: booking !== null }
}

/**
 * A customer placing a food order — either at a scanned station, or (no
 * stationToken) as a pickup/takeaway order off the homepage/food-menu. The
 * online-ordering counterpart of lib/actions/orders.ts:createOrder, sharing
 * the exact same createOrderCore (no forked pricing/KOT logic). The station
 * token — not a raw resourceId — is the only thing trusted from the client;
 * everything else (branch, resource, active booking, item availability,
 * price) is re-resolved server-side.
 */
export async function placeOnlineOrder(raw: z.input<typeof orderInput>): Promise<PlaceOnlineOrderResult> {
  try {
    // Cheapest check first, before any DB work — same budget class as
    // createPublicBooking's per-IP check in lib/actions/public-booking.ts.
    if (!rateLimit(`order:ip:${await callerIp()}`, 8, 10 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
    }

    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant

    const v = orderInput.parse(raw)

    // Bot bait — see the `website` field's doc comment on orderInput. Fails
    // the same generic way a real validation error would, so a bot reading
    // the response can't tell it was caught by the honeypot.
    if (v.website) {
      return { error: 'Something went wrong. Please try again.' }
    }

    // Per-phone, on top of the per-IP check above: catches a script that
    // rotates IPs but keeps hammering one number.
    const phoneDigits = v.customerPhone.replace(/\D/g, '')
    if (phoneDigits && !rateLimit(`order:phone:${phoneDigits}`, 5, 10 * 60_000).ok) {
      return { error: 'Too many attempts for this phone number. Please wait a bit and try again.' }
    }

    let branchId: string
    let resourceId: string | undefined
    let bookingId: string | undefined
    // A pickup order (no station and no attached booking), or a scanned
    // station with no booking currently open against it — "no open booking
    // to add to", the exact boundary M14 #6 (v2) draws for pay-now vs.
    // add-to-bill. Re-derived here from the SAME station/booking rows just
    // fetched, never trusted from the client's stale hasActiveBooking.
    let standalone = true
    if (v.stationToken) {
      const station = await getPublicStation(tenant.id, v.stationToken)
      if (!station) return { error: 'This station is not available for ordering right now.' }

      // Per-station on top of the per-IP check: catches a flood aimed at one
      // table regardless of how many devices/IPs it comes from.
      if (!rateLimit(`order:station:${station.resource.id}`, 20, 10 * 60_000).ok) {
        return { error: RATE_LIMIT_MESSAGE }
      }

      branchId = station.branchId
      resourceId = station.resource.id
      standalone = !station.bookingId
    } else {
      // No QR scan — a pickup/takeaway order against the tenant's primary
      // branch, with no table/resource attached.
      const branch = await getPublicBranch(tenant.id)
      if (!branch) return { error: 'Online ordering is not available right now.' }
      branchId = branch.id

      // The add-food-to-your-visit nudge: no table, but a specific booking to
      // attach to. A stale/invalid/no-longer-open token degrades silently to
      // the plain pickup order above rather than blocking checkout.
      if (v.bookingToken) {
        const booking = await getPublicBookingForOrder(tenant.id, v.bookingToken)
        if (booking) {
          branchId = booking.branchId
          bookingId = booking.id
          standalone = false
        }
      }
    }

    if (v.payNow && !standalone) {
      return { error: 'This table already has an open booking — add this order to the bill instead.' }
    }

    const result = await withPublicTenant(tenant.id, async (tx) => {
      // Re-check availability fresh, in this transaction — never trust the
      // cart's client-side snapshot, which may be stale (an item can flip to
      // out_of_stock/hidden between browsing and submitting).
      const ids = [...new Set(v.items.map((i) => i.menuItemId))]
      const available = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(and(eq(menuItems.tenantId, tenant.id), inArray(menuItems.id, ids), eq(menuItems.status, 'available')))
      if (available.length !== ids.length) {
        throw new OrderError('One or more items in your order are no longer available. Please review your cart.')
      }

      // Phone-first identification, exactly like createPublicBooking: a name
      // is only required the first time this phone number is seen. Checked
      // fresh here (never trusting the client's "already known" state) and
      // find-or-created idempotently, so re-submitting never creates a
      // duplicate customer for the same number.
      const existingCustomer = await findCustomerByRawPhone(tx, tenant.id, v.customerPhone)
      if (!existingCustomer && !v.customerName?.trim()) {
        throw new OrderError('Enter your name.')
      }
      const customer = await findOrCreateCustomer(tx, tenant.id, {
        phone: v.customerPhone,
        name: v.customerName || undefined,
        email: v.customerEmail || undefined,
      })
      await setNotifyOrderReady(tx, tenant.id, customer.id, v.notifyOrderReady)

      // Whether this order needs a human to accept it before the kitchen sees
      // it (lib/orders/service.ts's acceptanceStatus gate) is a per-tenant
      // choice — read fresh, in this transaction, never cached across orders.
      // Moot when payNow: a prepaid order skips the accept/reject queue
      // entirely (payment is the confirmation) and goes straight to
      // 'awaiting_payment' instead.
      const settings = await getOrderSettingsCore(tx, tenant.id)
      const awaitingPayment = Boolean(v.payNow) && standalone

      const created = await createOrderCore(
        tx,
        { tenantId: tenant.id, timezone: tenant.timezone, membershipId: null },
        {
          branchId,
          resourceId,
          bookingId,
          customerId: customer.id,
          channel: 'online',
          acceptanceStatus: awaitingPayment
            ? 'awaiting_payment'
            : settings.autoAcceptOnlineOrders
              ? 'accepted'
              : 'pending',
          idempotencyKey: v.idempotencyKey,
          items: v.items,
        },
      )
      return {
        ...created,
        pendingAcceptance: !awaitingPayment && !settings.autoAcceptOnlineOrders,
        awaitingPayment,
      }
    })

    return {
      orderNumber: result.orderNumber,
      orderId: result.id,
      pendingAcceptance: result.pendingAcceptance,
      awaitingPayment: result.awaitingPayment,
    }
  } catch (e) {
    // Idempotency race: two requests with the same key both passed
    // createOrderCore's own pre-check and collided on
    // orders_tenant_idempotency_key — the transaction that hit this is
    // already aborted, so re-fetch the winner's order in a fresh one and
    // return THAT, instead of surfacing a raw conflict to whichever request
    // happened to lose the race. Only ever matches a genuine retry of this
    // exact attempt (same idempotencyKey), never a different customer's order.
    const { code, constraint } = pgError(e)
    if (code === '23505' && constraint === 'orders_tenant_idempotency_key') {
      const tenant = await resolvePublicTenant()
      if (!('error' in tenant)) {
        const parsed = orderInput.safeParse(raw)
        if (parsed.success) {
          const existing = await withPublicTenant(tenant.id, (tx) =>
            tx
              .select({ id: orders.id, orderNumber: orders.orderNumber, acceptanceStatus: orders.acceptanceStatus })
              .from(orders)
              .where(and(eq(orders.tenantId, tenant.id), eq(orders.idempotencyKey, parsed.data.idempotencyKey)))
              .limit(1),
          )
          if (existing[0]) {
            return {
              orderNumber: existing[0].orderNumber,
              orderId: existing[0].id,
              pendingAcceptance: existing[0].acceptanceStatus === 'pending',
              awaitingPayment: existing[0].acceptanceStatus === 'awaiting_payment',
            }
          }
        }
      }
    }
    if (e instanceof OrderError) return { error: e.message }
    if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}

/* ── M14 #6 (v2): pay-now for a standalone order ─────────────────────────────
 *
 * Sibling to createDepositOrder (lib/actions/payments.ts), but PUBLIC —
 * customer-initiated from the unauthenticated /checkout page, not staff-
 * initiated from a session. No requireContext()/canBill(): there is no staff
 * member here to authorise, only a venue (resolved from the subdomain) and an
 * order that already exists, awaiting payment.
 *
 * Creating a gateway order is NOT taking a payment. This leaves the intent at
 * status='pending'; the webhook (lib/payments/webhook.ts) is the only thing
 * that may ever mark it paid.
 */

export type CreateOrderPaymentIntentResult = {
  error?: string
  checkout?: OrderPaymentCheckout
}

/** Same narrow-failure discipline as lib/actions/payments.ts's failDeposit. */
function failOrderPayment(e: unknown): CreateOrderPaymentIntentResult {
  if (e instanceof OrderPaymentError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  if (e instanceof OrphanedOrderPaymentError) {
    console.error(
      `[public-orders] order-payment intent NOT persisted after gateway order ${e.gatewayOrderId} was created — reconcile this order`,
    )
    return { error: e.message }
  }

  if (e instanceof RazorpayApiError) {
    console.error(`[public-orders] razorpay order creation failed with status ${e.status}`)
    return {
      error: e.retriable
        ? 'The payment gateway is not responding. Please try again in a moment.'
        : e.message,
    }
  }

  console.error('[public-orders] createOrderPaymentIntent failed:', e instanceof Error ? e.name : 'unknown')
  return { error: 'Could not start the payment. Please try again.' }
}

/**
 * Open a Razorpay order for a standalone order's total.
 *
 * The client sends only an order id. Credentials are loaded fresh for this
 * tenant (never cached from an earlier call, never trusted from the client);
 * a tenant with no Razorpay configured returns a friendly error rather than
 * throwing — this is the "fall back / disable pay-now" path, mirrored by the
 * checkout page proactively hiding the button when the same loader returns
 * null server-side.
 */
export async function createOrderPaymentIntent(
  input: z.input<typeof createOrderPaymentIntentInputSchema>,
): Promise<CreateOrderPaymentIntentResult> {
  try {
    if (!rateLimit(`order-pay:ip:${await callerIp()}`, 8, 10 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
    }

    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant

    const v = createOrderPaymentIntentInputSchema.parse(input)

    const credentials = await loadRazorpayCredentialsForTenant(tenant.id)
    if (!credentials) {
      return { error: 'Online payment is not available for this venue right now.' }
    }

    const checkout = await createOrderPaymentIntentCore(v, {
      runInTx: (fn) => withPublicTenant(tenant.id, fn),
      credentials,
      createOrder: createRazorpayOrder,
      actor: { tenantId: tenant.id },
    })

    return { checkout }
  } catch (e) {
    return failOrderPayment(e)
  }
}
