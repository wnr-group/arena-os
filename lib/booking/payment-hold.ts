import 'server-only'
import { and, eq, isNotNull, lt } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ownerDb } from '@/db'
import type * as schema from '@/db/schema'
import { auditLog, bookingAddons, bookings, paymentIntents } from '@/db/schema'
import { addonHeadroom, lockAddonCatalog } from './addons'

type Db = NodePgDatabase<typeof schema>

/** The cancellation reason a released hold carries. The late-payment path keys
 *  off it: only a booking WE released (not one staff cancelled) is re-confirmed. */
export const HOLD_RELEASE_REASON = 'Payment not completed'

/** SQLSTATE of the exclusion constraint on booking_slots. */
const EXCLUSION_VIOLATION = '23P01'

function pgCode(e: unknown): string | undefined {
  let cur: unknown = e
  for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
    const o = cur as { code?: unknown; cause?: unknown }
    if (typeof o.code === 'string') return o.code
    cur = o.cause
  }
}

/**
 * Release unpaid pending_payment holds whose window has passed (M36 #4).
 *
 * Runs on the OWNER connection (a locking read needs an UPDATE policy the
 * system has no user for), optionally scoped to one tenant — the public
 * booking actions call it per tenant so an expired hold never blocks a real
 * customer while the scheduler is late.
 *
 * One transaction per booking. `FOR UPDATE SKIP LOCKED` means an overlapping
 * sweep, or the webhook holding the same booking row, makes this run skip it
 * instead of waiting or double-acting; the webhook takes the same row lock
 * before settling, so for any one booking exactly one of {confirm, release}
 * happens, and if release wins the webhook takes the late-payment path.
 *
 * Cancelling flips status -> 'cancelled', and the 0003 trigger deactivates the
 * slots (slot + add-on stock are freed by the same mechanism a staff cancel
 * uses). Nothing was paid, so deposit_review_required is NOT raised. The
 * pending gateway intent is deliberately left pending: if the customer pays
 * after all, the webhook must still be able to find and settle it.
 */
export async function releaseExpiredHolds(
  opts: { tenantId?: string; limit?: number; now?: Date } = {},
  db: Db = ownerDb,
): Promise<{ released: number }> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 200

  const candidates = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'pending_payment'),
        lt(bookings.paymentHoldExpiresAt, now),
        opts.tenantId ? eq(bookings.tenantId, opts.tenantId) : undefined,
      ),
    )
    .limit(limit)

  let released = 0
  for (const { id } of candidates) {
    const done = await db.transaction(async (tx) => {
      const [b] = await tx
        .select({ id: bookings.id, tenantId: bookings.tenantId })
        .from(bookings)
        .where(
          and(
            eq(bookings.id, id),
            eq(bookings.status, 'pending_payment'),
            lt(bookings.paymentHoldExpiresAt, now),
          ),
        )
        .for('update', { skipLocked: true })
      if (!b) return false // confirmed meanwhile, already released, or locked by the webhook

      // Belt and braces: money already recorded means the webhook owns this one.
      const [paid] = await tx
        .select({ id: paymentIntents.id })
        .from(paymentIntents)
        .where(and(eq(paymentIntents.bookingId, b.id), eq(paymentIntents.status, 'paid')))
        .limit(1)
      if (paid) return false

      await tx
        .update(bookings)
        .set({ status: 'cancelled', cancelledAt: now, cancellationReason: HOLD_RELEASE_REASON })
        .where(eq(bookings.id, b.id))
      await tx.insert(auditLog).values({
        tenantId: b.tenantId,
        actorMembershipId: null,
        action: 'booking.payment_hold_released',
        entityType: 'booking',
        entityId: b.id,
        before: { status: 'pending_payment' },
        after: { status: 'cancelled', reason: HOLD_RELEASE_REASON },
      })
      return true
    })
    if (done) released++
  }
  return { released }
}

/** Best-effort per-tenant sweep for the public actions: never throws. */
export async function sweepTenantHolds(tenantId: string): Promise<void> {
  try {
    await releaseExpiredHolds({ tenantId, limit: 50 })
  } catch (e) {
    console.error('[payment-hold] on-demand sweep failed:', e instanceof Error ? e.name : 'unknown')
  }
}

export type LatePaymentOutcome = 'reinstated' | 'paid_after_release'

class AddonStockGone extends Error {}

/**
 * A verified payment arrived for a booking that is no longer pending (M36 #4).
 * Caller holds the booking row lock and is inside the webhook transaction.
 *
 *  - we released it (reason HOLD_RELEASE_REASON) and the slot AND add-on stock
 *    are still free -> reinstate it as confirmed. The exclusion constraint on
 *    booking_slots is the arbiter: re-activating the slots (the 0003 trigger,
 *    on the status update) raises 23P01 if someone else took the time, inside
 *    a savepoint so the money stays recorded.
 *  - otherwise (slot taken, stock gone, or staff had cancelled it) -> stays
 *    cancelled, deposit_review_required = true so staff see "paid, refund
 *    required". Never auto-refunded.
 */
export async function handleLatePayment(
  tx: Db,
  b: { id: string; tenantId: string; cancellationReason: string | null },
  amount: string,
): Promise<LatePaymentOutcome> {
  let reinstated = false
  let why = 'booking was cancelled before payment arrived'

  if (b.cancellationReason === HOLD_RELEASE_REASON) {
    try {
      await tx.transaction(async (sp) => {
        await assertAddonStockFree(sp, b.tenantId, b.id)
        await sp
          .update(bookings)
          .set({ status: 'confirmed', cancelledAt: null, cancellationReason: null, paymentHoldExpiresAt: null })
          .where(eq(bookings.id, b.id))
      })
      reinstated = true
    } catch (e) {
      if (pgCode(e) === EXCLUSION_VIOLATION) why = 'slot taken by another booking'
      else if (e instanceof AddonStockGone) why = 'add-on stock no longer available'
      else throw e
    }
  }

  if (!reinstated) {
    await tx.update(bookings).set({ depositReviewRequired: true }).where(eq(bookings.id, b.id))
  }
  await tx.insert(auditLog).values({
    tenantId: b.tenantId,
    actorMembershipId: null,
    action: reinstated ? 'booking.reinstated_after_late_payment' : 'booking.paid_after_release',
    entityType: 'booking',
    entityId: b.id,
    before: { status: 'cancelled' },
    after: reinstated
      ? { status: 'confirmed', amount }
      : { status: 'cancelled', amount, reason: why, refundRequired: true },
  })
  return reinstated ? 'reinstated' : 'paid_after_release'
}

/** Every add-on line of the booking must still fit (the booking is cancelled,
 *  so its own rows are not counted against it). Same lock-then-count discipline
 *  as attachAddonsToSlots. */
async function assertAddonStockFree(tx: Db, tenantId: string, bookingId: string): Promise<void> {
  const lines = await tx
    .select({
      addonId: bookingAddons.addonId,
      quantity: bookingAddons.quantity,
      startsAt: bookingAddons.startsAt,
      endsAt: bookingAddons.endsAt,
    })
    .from(bookingAddons)
    .where(
      and(
        eq(bookingAddons.tenantId, tenantId),
        eq(bookingAddons.bookingId, bookingId),
        isNotNull(bookingAddons.addonId),
      ),
    )
  if (lines.length === 0) return
  const catalog = await lockAddonCatalog(tx, tenantId, [...new Set(lines.map((l) => l.addonId!))])
  const FAR = new Date(8.64e15)
  for (const l of lines) {
    const row = catalog.get(l.addonId!)
    if (!row) throw new AddonStockGone()
    const free = await addonHeadroom(tx, tenantId, row, l.startsAt, l.endsAt)
    const wanted = lines
      .filter((o) => o.addonId === l.addonId && o.startsAt < (l.endsAt ?? FAR) && l.startsAt < (o.endsAt ?? FAR))
      .reduce((s, o) => s + o.quantity, 0)
    if (wanted > free) throw new AddonStockGone()
  }
}
