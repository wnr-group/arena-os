'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { assertCanOverride } from '@/lib/reservations/guard'
import { BookingError } from '@/lib/booking/service'
import { isValidPhone } from '@/lib/customers/phone'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { ReservationConflictError } from '@/lib/reservations/guard'
import {
  addWaitlistEntryCore,
  estimateNewPartyWait,
  leaveWaitlistCore,
  markWaitlistNotifiedCore,
  seatWaitlistEntryCore,
  sendWaitlistReady,
  type WaitEstimate,
} from '@/lib/waitlist/service'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

const MODULE = 'module.waitlist'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof BookingError || e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const pg = pgError(e)
  if (pg?.code === '23505' && pg.constraint === 'idx_bookings_open_table_session') {
    return { error: 'That table was just taken. Pick another table.' }
  }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** Restaurant-only, plan-gated, front-of-house roles — enforced here, not by hiding UI. */
async function requireHost() {
  const ctx = await requireContext()
  if (ctx.tenant.industry !== 'restaurant') throw new AuthError('The waitlist is for restaurant venues.')
  if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to manage the waitlist.')
  await requireEntitlement(ctx, MODULE)
  return ctx
}

const actorOf = (ctx: Awaited<ReturnType<typeof requireHost>>) => ({
  tenantId: ctx.tenant.id,
  timezone: ctx.tenant.timezone,
  membershipId: ctx.membershipId,
})

const addInput = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1, 'Enter the guest’s name.').max(100),
  phone: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  partySize: z.coerce.number().int().positive('Party size must be at least 1.'),
  quotedWaitMinutes: z.coerce.number().int().min(0).max(600).nullable().optional(),
  notes: z.string().trim().max(300).optional(),
})

export async function addToWaitlist(input: z.input<typeof addInput>): Promise<Result & { id?: string }> {
  try {
    const ctx = await requireHost()
    const v = addInput.parse(input)
    const r = await withUser(ctx.user.id, (tx) => addWaitlistEntryCore(tx, actorOf(ctx), v))
    revalidatePath('/waitlist')
    revalidatePath('/floor')
    return { id: r.id }
  } catch (e) {
    return fail(e)
  }
}

/** The quote to pre-fill on the "add party" form. */
export async function getWaitQuote(branchId: string): Promise<Result & { estimate?: WaitEstimate }> {
  try {
    const ctx = await requireHost()
    const id = z.string().uuid().parse(branchId)
    const estimate = await withUser(ctx.user.id, (tx) => estimateNewPartyWait(tx, ctx.tenant.id, id))
    return { estimate }
  } catch (e) {
    return fail(e)
  }
}

export type NotifyResult = Result & {
  /** Text message that was (or would have been) sent. */
  message?: string
  /** 'sent' | 'skipped' | 'failed' — skipped is normal until an SMS provider exists. */
  delivery?: 'sent' | 'skipped' | 'failed'
  skipReason?: string
  /** Click-to-chat fallback; null when the party gave no phone. */
  whatsappUrl?: string | null
}

/**
 * "Your table is ready". The party is flagged notified first and committed; the
 * text is then attempted in a separate transaction and can never undo that flag.
 */
export async function notifyWaitlistParty(entryId: string): Promise<NotifyResult> {
  try {
    const ctx = await requireHost()
    const id = z.string().uuid().parse(entryId)
    const marked = await withUser(ctx.user.id, (tx) => markWaitlistNotifiedCore(tx, actorOf(ctx), id, ctx.tenant.name))
    const outcome = await withUser(ctx.user.id, (tx) =>
      sendWaitlistReady(tx, { tenantId: ctx.tenant.id }, { phone: marked.phone, message: marked.message }),
    )
    revalidatePath('/waitlist')
    return { message: marked.message, delivery: outcome.status, skipReason: outcome.skipReason, whatsappUrl: marked.whatsappUrl }
  } catch (e) {
    return fail(e)
  }
}

const seatInput = z.object({
  entryId: z.string().uuid(),
  resourceId: z.string().uuid(),
  coverCount: z.coerce.number().int().positive('Guest count must be at least 1.').optional(),
  overrideReservation: z.boolean().optional(),
})

/** Seat a queued party at a free table: opens the session and clears the entry. */
export async function seatFromWaitlist(
  input: z.input<typeof seatInput>,
): Promise<Result & { bookingId?: string; reservationConflict?: boolean }> {
  try {
    const ctx = await requireHost()
    const v = seatInput.parse(input)
    assertCanOverride(ctx.role, v.overrideReservation)
    const r = await withUser(ctx.user.id, (tx) => seatWaitlistEntryCore(tx, actorOf(ctx), v))
    revalidatePath('/waitlist')
    revalidatePath('/floor')
    return { bookingId: r.bookingId }
  } catch (e) {
    if (e instanceof ReservationConflictError) return { error: e.message, reservationConflict: true }
    return fail(e)
  }
}

/** The party gave up and left. */
export async function removeFromWaitlist(entryId: string): Promise<Result> {
  try {
    const ctx = await requireHost()
    const id = z.string().uuid().parse(entryId)
    await withUser(ctx.user.id, (tx) => leaveWaitlistCore(tx, actorOf(ctx), id))
    revalidatePath('/waitlist')
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}
