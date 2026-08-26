'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { menuItems } from '@/db/schema'
import { resolvePublicTenant } from '@/lib/tenant/public'
import { getPublicStation, getPublicBranch } from '@/lib/booking/public-availability'
import { createOrderCore, OrderError } from '@/lib/orders/service'
import { getOrderSettingsCore } from '@/lib/orders/settings'
import { findCustomerByRawPhone, findOrCreateCustomer } from '@/lib/customers/service'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'
import { zodErrorMessage } from '@/lib/utils/errors'

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

const orderInput = z.object({
  // Present when the customer scanned a station's QR code; absent when
  // ordering from the homepage/food-menu without a table — that order is
  // placed as a pickup/takeaway order tied only to the tenant's branch.
  stationToken: z.string().uuid().optional(),
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
})

export type PlaceOnlineOrderResult = { error?: string; orderNumber?: string; pendingAcceptance?: boolean }

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
    } else {
      // No QR scan — a pickup/takeaway order against the tenant's primary
      // branch, with no table/resource attached.
      const branch = await getPublicBranch(tenant.id)
      if (!branch) return { error: 'Online ordering is not available right now.' }
      branchId = branch.id
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

      // Whether this order needs a human to accept it before the kitchen sees
      // it (lib/orders/service.ts's acceptanceStatus gate) is a per-tenant
      // choice — read fresh, in this transaction, never cached across orders.
      const settings = await getOrderSettingsCore(tx, tenant.id)

      const created = await createOrderCore(
        tx,
        { tenantId: tenant.id, timezone: tenant.timezone, membershipId: null },
        {
          branchId,
          resourceId,
          customerId: customer.id,
          channel: 'online',
          acceptanceStatus: settings.autoAcceptOnlineOrders ? 'accepted' : 'pending',
          items: v.items,
        },
      )
      return { ...created, pendingAcceptance: !settings.autoAcceptOnlineOrders }
    })

    return { orderNumber: result.orderNumber, pendingAcceptance: result.pendingAcceptance }
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message }
    if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
