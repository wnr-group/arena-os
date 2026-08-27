'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { resolvePublicTenant } from '@/lib/tenant/public'
import { getRecentPublicOrdersByPhone, type PublicOrderSummary } from '@/lib/orders/public-status'
import { getRecentPublicBookingsByPhone, type PublicBookingSummary } from '@/lib/booking/public-status'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

const myBookingsLookupInput = z.object({
  phone: z.string().trim().min(1),
})

export type MyBookingsLookupResult =
  | { orders: PublicOrderSummary[]; bookings: PublicBookingSummary[] }
  | { error: string }

/**
 * The "My Booking" site-header entry point: one phone lookup that surfaces
 * BOTH a customer's recent food orders and their device/resource bookings,
 * reached from PublicNavbar's "My Booking" button (app/(public)/track).
 * Unauthenticated by design, same as its two underlying reads
 * (getRecentPublicOrdersByPhone / getRecentPublicBookingsByPhone) — no OTP/
 * accounts yet (M9) — so this carries its own per-IP/per-phone rate limit
 * rather than relying on either read's caller to have already applied one.
 */
export async function lookupMyBookings(raw: z.input<typeof myBookingsLookupInput>): Promise<MyBookingsLookupResult> {
  if (!rateLimit(`my-bookings:ip:${await callerIp()}`, 10, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const v = myBookingsLookupInput.safeParse(raw)
  if (!v.success) return { orders: [], bookings: [] }

  const phoneDigits = v.data.phone.replace(/\D/g, '')
  if (phoneDigits && !rateLimit(`my-bookings:phone:${phoneDigits}`, 5, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const [orders, bookings] = await Promise.all([
    getRecentPublicOrdersByPhone(tenant.id, v.data.phone),
    getRecentPublicBookingsByPhone(tenant.id, v.data.phone),
  ])
  return { orders, bookings }
}
