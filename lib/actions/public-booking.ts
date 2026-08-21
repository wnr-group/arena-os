'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { withPublicTenant } from '@/db'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicAvailableStartsForType, getPublicAvailableStarts } from '@/lib/booking/public-availability'
import { createBookingCore, BookingError } from '@/lib/booking/service'
import { findCustomerByRawPhone } from '@/lib/customers/service'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'

type Fail = { error: string }

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

async function resolvePublicTenant(): Promise<{ id: string; timezone: string } | Fail> {
  const slug = await currentTenantSlug()
  if (!slug) return { error: 'Unknown venue.' }
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) return { error: 'Unknown venue.' }
  return tenant
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
  /** Honeypot: a real visitor never sees or fills this field (it's rendered
   * off-screen and excluded from the tab order — see HoneypotField). A
   * non-empty value means whatever submitted the form filled in every input
   * it found, which is a form-filling bot, not a customer. */
  website: z.string().optional(),
})

export type CreatePublicBookingResult = { error?: string; bookingNumber?: string; confirmationToken?: string }

/**
 * Step 6 (confirm) of the booking wizard. Shares createBookingCore with the
 * staff action (lib/actions/bookings.ts) but never trusts the client for
 * branch, source, discount or deposit: the branch is resolved server-side
 * from the subdomain, source is hardcoded 'online' (also enforced at the
 * database layer — see 0023_public_booking_create.sql), and discount/deposit
 * are always zero — a stranger can never discount their own booking.
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
          deposit: 0,
          slots: [{ resourceId: v.resourceId, startsAt: v.startsAt, endsAt: v.endsAt }],
        },
      ),
    )

    revalidatePath('/bookings')
    return { bookingNumber: result.bookingNumber, confirmationToken: result.confirmationToken }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    // 23P01 = exclusion_violation: someone else took this slot first.
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23P01') {
      return { error: 'That time was just taken. Please pick another slot.' }
    }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
