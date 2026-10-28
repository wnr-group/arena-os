import 'server-only'
import { and, asc, eq, gt, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookings, bookingSlots, tenants } from '@/db/schema'
import { BookingError } from '@/lib/booking/booking-error'
import { formatTimeInZone } from '@/lib/booking/time'
import { isManager, type MemberRole } from '@/lib/auth/roles'
import { getReservationSettingsCore } from './settings'
import { reservationBlocksWalkin } from './rules'

type Db = NodePgDatabase<typeof schema>

/** A walk-in tried to take a table a reservation is about to need. The UI
 *  offers "seat anyway" for this one error, so it is its own class. */
export class ReservationConflictError extends BookingError {}

export type BlockingReservation = {
  /** The reservation's booking, or null when an EVENT holds the table. */
  bookingId: string | null
  kind: 'reservation' | 'event'
  customerName: string | null
  coverCount: number | null
  startsAt: Date
}

/**
 * Serialise everything that decides who may occupy one table. Held for the rest
 * of the transaction: a reservation being created, a party being seated and a
 * table transfer all take it first, so "is this table free?" and the write that
 * follows can't interleave with another one deciding the same thing.
 */
export async function lockTable(tx: Db, tenantId: string, resourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`table:${tenantId}:${resourceId}`}, 0))`)
}

/**
 * Seating on top of a reservation is a manager's call. The core only honours the
 * override; this is the check the actions make before passing it through.
 */
export function assertCanOverride(role: MemberRole | null | undefined, override: boolean | undefined): void {
  if (override && !isManager(role)) {
    throw new BookingError('Only a manager or owner can seat over a reservation.')
  }
}

/**
 * What stops a party being seated at `resourceId` right now:
 *   - an EVENT block (a booking_slots row with no booking) that is underway or
 *     starts inside the walk-in buffer — checked even when reservations are off,
 *     because events block tables regardless; or
 *   - a confirmed, not-yet-seated reservation inside the buffer (or underway) and
 *     not lapsed past the no-show grace. Skipped when reservations are off.
 * `excludeBookingId` is the reservation being seated itself, which never blocks
 * its own seating.
 */
export async function findBlockingReservation(
  tx: Db,
  tenantId: string,
  resourceId: string,
  now: Date = new Date(),
  excludeBookingId?: string,
): Promise<BlockingReservation | null> {
  const settings = await getReservationSettingsCore(tx, tenantId)
  const horizon = new Date(now.getTime() + settings.walkinBufferMinutes * 60_000)

  const [event] = await tx
    .select({ startsAt: bookingSlots.startsAt })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        eq(bookingSlots.resourceId, resourceId),
        eq(bookingSlots.active, true),
        isNull(bookingSlots.bookingId),
        lt(bookingSlots.startsAt, horizon),
        gt(bookingSlots.endsAt, now),
      ),
    )
    .orderBy(asc(bookingSlots.startsAt))
    .limit(1)
  if (event) {
    return { bookingId: null, kind: 'event', customerName: null, coverCount: null, startsAt: event.startsAt }
  }

  if (!settings.enabled) return null

  const candidates = await tx
    .select({
      bookingId: bookings.id,
      customerName: bookings.customerName,
      coverCount: bookings.coverCount,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
    })
    .from(bookingSlots)
    .innerJoin(bookings, eq(bookings.id, bookingSlots.bookingId))
    .where(
      and(
        eq(bookingSlots.tenantId, tenantId),
        eq(bookingSlots.resourceId, resourceId),
        eq(bookingSlots.active, true),
        eq(bookings.status, 'confirmed'),
        isNotNull(bookings.reservedFor),
        isNull(bookings.resourceId),
        excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
        lt(bookingSlots.startsAt, horizon),
        gt(bookingSlots.endsAt, now),
      ),
    )
    .orderBy(asc(bookingSlots.startsAt))

  for (const c of candidates) {
    if (!c.endsAt) continue
    if (reservationBlocksWalkin({ startsAt: c.startsAt, endsAt: c.endsAt }, now, settings.walkinBufferMinutes, settings.noShowGraceMinutes)) {
      return { bookingId: c.bookingId, kind: 'reservation', customerName: c.customerName, coverCount: c.coverCount, startsAt: c.startsAt }
    }
  }
  return null
}

async function timezoneOf(tx: Db, tenantId: string, given?: string): Promise<string> {
  if (given) return given
  const [t] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  return t?.timezone ?? 'UTC'
}

function conflictMessage(b: BlockingReservation, timezone: string): string {
  const at = formatTimeInZone(b.startsAt, timezone)
  if (b.kind === 'event') {
    return `This table is held for an event at ${at}. Seat them elsewhere, or seat anyway.`
  }
  const who = b.customerName ? ` for ${b.customerName}` : ''
  const covers = b.coverCount ? ` (${b.coverCount} guests)` : ''
  return `This table is reserved${who}${covers} at ${at}. Seat them elsewhere, or seat anyway.`
}

/**
 * The one check every path that puts a party on a table runs: walk-in seating,
 * seating a reservation, a late no-show, a table transfer and a split.
 *
 * Throws ReservationConflictError when something blocks the table. With
 * `override` it lets the party through but WRITES AN AUDIT ROW saying who seated
 * over what — the override is never silent. (The callers' actions are what
 * restrict `override` to managers; see assertCanOverride.)
 */
export async function guardTableSeating(
  tx: Db,
  ctx: { tenantId: string; timezone?: string; membershipId?: string | null },
  resourceId: string,
  opts: { override?: boolean; excludeBookingId?: string; bookingId?: string; now?: Date } = {},
): Promise<void> {
  const blocking = await findBlockingReservation(tx, ctx.tenantId, resourceId, opts.now, opts.excludeBookingId)
  if (!blocking) return
  if (!opts.override) {
    throw new ReservationConflictError(conflictMessage(blocking, await timezoneOf(tx, ctx.tenantId, ctx.timezone)))
  }
  await tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorMembershipId: ctx.membershipId ?? null,
    action: 'table.seat_override',
    entityType: 'resource',
    entityId: resourceId,
    before: {
      blockedBy: blocking.kind,
      blockingBookingId: blocking.bookingId,
      blockingStartsAt: blocking.startsAt.toISOString(),
      blockingName: blocking.customerName,
    },
    after: { seatedBookingId: opts.bookingId ?? null, overridden: true },
  })
}

/** Throws ReservationConflictError when a reservation blocks seating a walk-in. */
export async function assertNoUpcomingReservation(
  tx: Db,
  ctx: { tenantId: string; timezone: string },
  resourceId: string,
  now: Date = new Date(),
): Promise<void> {
  await guardTableSeating(tx, ctx, resourceId, { now })
}
