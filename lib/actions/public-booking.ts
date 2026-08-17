'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withPublicTenant } from '@/db'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicAvailableStartsForType, getPublicAvailableStarts } from '@/lib/booking/public-availability'
import { createBookingCore, BookingError } from '@/lib/booking/service'

type Fail = { error: string }

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

const bookingInput = z.object({
  resourceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  customerName: z.string().trim().min(1, 'Enter your name.').max(100),
  customerPhone: z.string().trim().min(6, 'Enter a valid phone number.').max(20),
  /** Not a first-class column — the schema has no per-booking player count,
   * so this rides along as a note, same as staff bookings already do. */
  players: z.coerce.number().int().min(1).max(100).optional(),
})

export type CreatePublicBookingResult = { error?: string; bookingNumber?: string }

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
    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant

    const v = bookingInput.parse(raw)
    if (new Date(v.endsAt) <= new Date(v.startsAt)) {
      return { error: 'That slot is no longer valid — please pick another.' }
    }

    const branch = await getPublicBranch(tenant.id)
    if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

    const result = await withPublicTenant(tenant.id, (tx) =>
      createBookingCore(
        tx,
        { tenantId: tenant.id, timezone: tenant.timezone, membershipId: null },
        {
          branchId: branch.id,
          customerName: v.customerName,
          customerPhone: v.customerPhone,
          notes: v.players ? `Players: ${v.players}` : undefined,
          source: 'online',
          discount: 0,
          deposit: 0,
          slots: [{ resourceId: v.resourceId, startsAt: v.startsAt, endsAt: v.endsAt }],
        },
      ),
    )

    revalidatePath('/bookings')
    return { bookingNumber: result.bookingNumber }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    // 23P01 = exclusion_violation: someone else took this slot first.
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23P01') {
      return { error: 'That time was just taken. Please pick another slot.' }
    }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
