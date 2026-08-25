'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { menuItems } from '@/db/schema'
import { resolvePublicTenant } from '@/lib/tenant/public'
import { getPublicStation } from '@/lib/booking/public-availability'
import { createOrderCore, OrderError } from '@/lib/orders/service'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'
import { zodErrorMessage } from '@/lib/utils/errors'

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

const orderInput = z.object({
  stationToken: z.string().uuid(),
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
})

export type PlaceOnlineOrderResult = { error?: string; orderNumber?: string }

/**
 * A customer at a scanned station placing a food order — the online-ordering
 * counterpart of lib/actions/orders.ts:createOrder, sharing the exact same
 * createOrderCore (no forked pricing/KOT logic). The station token — not a
 * raw resourceId — is the only thing trusted from the client; everything
 * else (branch, resource, active booking, item availability, price) is
 * re-resolved server-side.
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

    const station = await getPublicStation(tenant.id, v.stationToken)
    if (!station) return { error: 'This station is not available for ordering right now.' }

    // Per-station on top of the per-IP check: catches a flood aimed at one
    // table regardless of how many devices/IPs it comes from.
    if (!rateLimit(`order:station:${station.resource.id}`, 20, 10 * 60_000).ok) {
      return { error: RATE_LIMIT_MESSAGE }
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

      return createOrderCore(
        tx,
        { tenantId: tenant.id, timezone: tenant.timezone, membershipId: null },
        {
          branchId: station.branchId,
          resourceId: station.resource.id,
          channel: 'online',
          items: v.items,
        },
      )
    })

    return { orderNumber: result.orderNumber }
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message }
    if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
