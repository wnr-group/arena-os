'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { resolvePublicTenant } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { BookingError } from '@/lib/booking/service'
import { horizonMessage, horizonNow, isDateWithinHorizon } from '@/lib/booking/horizon'
import { publicMaxAdvanceDaysOrDefault } from '@/lib/booking/settings-server'
import { todayInZone } from '@/lib/booking/time'
import { isValidPhone } from '@/lib/customers/phone'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'
import { pgError } from '@/lib/utils/errors'
import { hasPublicEntitlement } from '@/lib/platform/entitlement-guard'
import {
  createReservationCore,
  freeTablesForWindow,
  getReservationStartOptionsCore,
  type StartOption,
} from '@/lib/reservations/service'
import { getReservationSettingsCore } from '@/lib/reservations/settings'
import { reservationEnd } from '@/lib/reservations/rules'

const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down and try again shortly.'
const UNAVAILABLE = 'Online table reservations are not available right now.'
const MODULE = 'module.table_reservations'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

async function horizonError(tenant: { id: string; timezone: string }, dateStr: string): Promise<string | null> {
  const max = await publicMaxAdvanceDaysOrDefault(tenant.id)
  const today = todayInZone(tenant.timezone, horizonNow())
  return isDateWithinHorizon(dateStr, today, max) ? null : horizonMessage(today, max)
}

const timesInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partySize: z.coerce.number().int().min(1).max(100),
})

export type PublicReservationTimes = { error?: string; options?: StartOption[]; maxPartySize?: number }

/** Open start times for one date — the storefront's "Book a table" picker. */
export async function getPublicReservationTimes(raw: z.input<typeof timesInput>): Promise<PublicReservationTimes> {
  if (!rateLimit(`resv-avail:${await callerIp()}`, 40, 60_000).ok) return { error: RATE_LIMIT_MESSAGE }
  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant
  if (tenant.industry !== 'restaurant') return { error: 'Table reservations are not available here.' }

  const v = timesInput.safeParse(raw)
  if (!v.success) return { error: 'Invalid request.' }
  const beyond = await horizonError(tenant, v.data.date)
  if (beyond) return { error: beyond }

  try {
    const branch = await getPublicBranch(tenant.id)
    if (!branch) return { error: 'Online booking is not set up for this venue yet.' }
    const settings = await withPublicTenant(tenant.id, (tx) => getReservationSettingsCore(tx, tenant.id))
    if (!settings.enabled || !settings.publicEnabled || !(await hasPublicEntitlement(tenant.id, MODULE))) {
      return { error: UNAVAILABLE }
    }
    if (v.data.partySize > settings.maxPartySize) {
      return { error: `For parties larger than ${settings.maxPartySize}, please call us to reserve.` }
    }
    const r = await withPublicTenant(tenant.id, (tx) =>
      getReservationStartOptionsCore(tx, { id: tenant.id, timezone: tenant.timezone }, { branchId: branch.id, date: v.data.date, partySize: v.data.partySize }, 'public'),
    )
    return { options: r.options, maxPartySize: settings.maxPartySize }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    console.error('[public-reservations] times failed', e)
    return { error: 'Could not load times. Please try again.' }
  }
}

const reserveInput = z.object({
  startsAt: z.string().datetime(),
  partySize: z.coerce.number().int().min(1).max(100),
  customerName: z.string().trim().min(1, 'Enter your name.').max(100),
  customerPhone: z
    .string()
    .trim()
    .min(1, 'Enter a phone number.')
    .refine((v) => isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  customerEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional(),
  /** Honeypot — a real visitor never fills this in. */
  website: z.string().optional(),
  /** One per form attempt: a double-click or retry resolves to the first booking. */
  idempotencyKey: z.string().uuid(),
})

export type PublicReservationResult = {
  error?: string
  confirmation?: { bookingNumber: string; confirmationToken: string; startsAt: string; partySize: number }
}

type Confirmation = NonNullable<PublicReservationResult['confirmation']>

/** The booking an earlier submit with this key created, if any. */
async function existingConfirmation(tenantId: string, key: string): Promise<Confirmation | null> {
  const r = await withPublicTenant(tenantId, (tx) =>
    tx.execute(sql`select booking_number, confirmation_token, reserved_for, cover_count
                     from public.reservation_by_idempotency_key(${tenantId}::uuid, ${key})`),
  )
  const row = r.rows[0] as
    | { booking_number: string; confirmation_token: string; reserved_for: Date | string; cover_count: number }
    | undefined
  if (!row) return null
  return {
    bookingNumber: row.booking_number,
    confirmationToken: row.confirmation_token,
    startsAt: new Date(row.reserved_for).toISOString(),
    partySize: row.cover_count,
  }
}

/**
 * Reserve a table from the storefront. The visitor never picks a table: the
 * first one free for the whole window is assigned, and if a race takes it the
 * next candidate is tried (each attempt in its own transaction — a failed
 * insert aborts the one it ran in). The booking_slots exclusion constraint,
 * not this loop, is what guarantees no double-booking.
 */
export async function createPublicReservation(raw: z.input<typeof reserveInput>): Promise<PublicReservationResult> {
  try {
    if (!rateLimit(`resv:ip:${await callerIp()}`, 5, 10 * 60_000).ok) {
      return { error: 'Too many booking attempts. Please wait a bit and try again.' }
    }
    const tenant = await resolvePublicTenant()
    if ('error' in tenant) return tenant
    if (tenant.industry !== 'restaurant') return { error: 'Table reservations are not available here.' }
    // The plan may have been downgraded since the owner switched this on.
    if (!(await hasPublicEntitlement(tenant.id, MODULE))) return { error: UNAVAILABLE }

    const parsed = reserveInput.safeParse(raw)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' }
    const v = parsed.data
    if (v.website) return { error: 'Something went wrong. Please try again.' }

    // A repeat of an already-completed submit returns that confirmation, before
    // any rate limit is spent on it.
    const prior = await existingConfirmation(tenant.id, v.idempotencyKey)
    if (prior) return { confirmation: prior }

    const phoneDigits = v.customerPhone.replace(/\D/g, '')
    if (!rateLimit(`resv:phone:${phoneDigits}`, 3, 10 * 60_000).ok) {
      return { error: 'Too many booking attempts for this phone number. Please wait a bit and try again.' }
    }

    const start = new Date(v.startsAt)
    const dateStr = todayInZone(tenant.timezone, start)
    const beyond = await horizonError(tenant, dateStr)
    if (beyond) return { error: beyond }

    const branch = await getPublicBranch(tenant.id)
    if (!branch) return { error: 'Online booking is not set up for this venue yet.' }

    const settings = await withPublicTenant(tenant.id, (tx) => getReservationSettingsCore(tx, tenant.id))
    if (!settings.enabled || !settings.publicEnabled) return { error: UNAVAILABLE }

    const candidates = await withPublicTenant(tenant.id, (tx) =>
      freeTablesForWindow(tx, tenant.id, branch.id, start, reservationEnd(start, settings.defaultDurationMinutes), new Date(), v.partySize),
    )
    if (candidates.length === 0) return { error: 'Sorry, that time was just taken — please pick another.' }

    for (const table of candidates.slice(0, 5)) {
      try {
        const created = await withPublicTenant(tenant.id, (tx) =>
          createReservationCore(
            tx,
            { tenantId: tenant.id, timezone: tenant.timezone, membershipId: null },
            {
              branchId: branch.id,
              resourceId: table.id,
              startsAt: v.startsAt,
              partySize: v.partySize,
              customerName: v.customerName,
              customerPhone: v.customerPhone,
              customerEmail: v.customerEmail || undefined,
              notes: v.notes,
              idempotencyKey: v.idempotencyKey,
            },
            'public',
          ),
        )
        revalidatePath('/reservations')
        revalidatePath('/floor')
        return {
          confirmation: {
            bookingNumber: created.bookingNumber,
            confirmationToken: created.confirmationToken,
            startsAt: v.startsAt,
            partySize: v.partySize,
          },
        }
      } catch (e) {
        // Lost a race for this table — try the next free one.
        if (pgError(e)?.code === '23P01') continue
        // Same key already used: a concurrent double-submit won — show its booking.
        if (pgError(e)?.code === '23505') {
          const dup = await existingConfirmation(tenant.id, v.idempotencyKey)
          if (dup) return { confirmation: dup }
        }
        throw e
      }
    }
    return { error: 'Sorry, that time was just taken — please pick another.' }
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message }
    console.error('[public-reservations] create failed', e)
    return { error: 'Could not complete your reservation. Please try again.' }
  }
}
