import 'server-only'
import { and, desc, eq, inArray, isNull, or, isNotNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ownerDb } from '@/db'
import type * as schema from '@/db/schema'
import { auditLog, bookingSettings, bookings, bookingSlots, tenants, workingHours } from '@/db/schema'
import { checkoutWalkinCore, WALKIN_LATE_CHECKOUT_MAX_DAYS } from './walkin'
import { walkinCloseDeadline, type DayHours } from './walkin-auto-close-rules'

type Db = NodePgDatabase<typeof schema>

/**
 * Close open-tab walk-ins that were never checked out (booking_settings
 * .walkin_auto_close_minutes / walkin_auto_close_at_closing, 0167/0168).
 *
 * A candidate is an active, still-open slot of a checked-in open-tab walk-in
 * whose tenant has an auto-close rule on. Its deadline is the earlier of
 * start + the max length and the next closing time (walkinCloseDeadline); once
 * that has passed it is closed through checkoutWalkinCore — the same pricing,
 * rounding, add-on and head-count path as a staff checkout — with the end set to
 * the DEADLINE, not "now": a cron that runs late (or a long outage) never bills
 * the customer for time past it.
 *
 * Like a manual checkout it only prices the session; the booking stays
 * checked-in and unpaid so staff settle it in POS. It runs on the OWNER
 * connection (no user), one transaction per booking, so one failure (e.g. the
 * deadline is older than the 7-day late-checkout window) never blocks the rest.
 * Checkout locks the booking row, so a staff checkout racing the cron simply
 * makes one of them see "already checked out" — it is skipped, not double-billed.
 */
export async function autoCloseOverdueWalkins(
  opts: { tenantId?: string; limit?: number; now?: Date } = {},
  db: Db = ownerDb,
): Promise<{ closed: number; failed: number }> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 100

  const open = await db
    .select({
      bookingId: bookings.id,
      tenantId: bookings.tenantId,
      branchId: bookings.branchId,
      timezone: tenants.timezone,
      startsAt: bookingSlots.startsAt,
      limitMinutes: bookingSettings.walkinAutoCloseMinutes,
      atClosing: bookingSettings.walkinAutoCloseAtClosing,
    })
    .from(bookings)
    .innerJoin(bookingSlots, and(eq(bookingSlots.bookingId, bookings.id), eq(bookingSlots.active, true)))
    .innerJoin(bookingSettings, eq(bookingSettings.tenantId, bookings.tenantId))
    .innerJoin(tenants, eq(tenants.id, bookings.tenantId))
    .where(
      and(
        eq(bookings.channel, 'walkin'),
        eq(bookings.billingMode, 'open_tab'),
        eq(bookings.status, 'checked_in'),
        isNull(bookingSlots.endsAt),
        or(isNotNull(bookingSettings.walkinAutoCloseMinutes), eq(bookingSettings.walkinAutoCloseAtClosing, true)),
        opts.tenantId ? eq(bookings.tenantId, opts.tenantId) : undefined,
      ),
    )
    // Newest first: a tab too old to ever close (see the window filter below)
    // must not sit at the front of the queue and crowd newer ones out.
    .orderBy(desc(bookingSlots.startsAt))
    .limit(1000)
  if (open.length === 0) return { closed: 0, failed: 0 }

  // Opening hours only matter to the closing-time rule.
  const hoursByBranch = new Map<string, Map<number, DayHours>>()
  const branchIds = [...new Set(open.filter((o) => o.atClosing).map((o) => o.branchId))]
  if (branchIds.length > 0) {
    const rows = await db
      .select({
        branchId: workingHours.branchId,
        dayOfWeek: workingHours.dayOfWeek,
        openTime: workingHours.openTime,
        closeTime: workingHours.closeTime,
        isClosed: workingHours.isClosed,
        open24h: workingHours.open24h,
      })
      .from(workingHours)
      .where(inArray(workingHours.branchId, branchIds))
    for (const r of rows) {
      const byDow = hoursByBranch.get(r.branchId) ?? new Map<number, DayHours>()
      byDow.set(r.dayOfWeek, r)
      hoursByBranch.set(r.branchId, byDow)
    }
  }

  const due = open
    .map((o) => ({
      ...o,
      deadline: walkinCloseDeadline({
        startsAt: o.startsAt,
        timeZone: o.timezone,
        limitMinutes: o.limitMinutes,
        atClosing: o.atClosing,
        hoursByDow: hoursByBranch.get(o.branchId) ?? new Map(),
      }),
    }))
    .filter((o): o is typeof o & { deadline: Date } => o.deadline !== null && o.deadline.getTime() <= now.getTime())
    // checkoutWalkinCore refuses an end older than the late-checkout window, so
    // such a tab can never auto-close: leave it for staff instead of retrying it
    // (and counting it as failed) on every sweep.
    .filter((o) => now.getTime() - o.deadline.getTime() <= WALKIN_LATE_CHECKOUT_MAX_DAYS * 24 * 60 * 60_000)
    // Oldest deadline first among the closeable ones.
    .sort((a, b) => a.deadline.getTime() - b.deadline.getTime())
    .slice(0, limit)

  let closed = 0
  let failed = 0
  for (const c of due) {
    try {
      await db.transaction(async (tx) => {
        const { total } = await checkoutWalkinCore(
          tx,
          { tenantId: c.tenantId, timezone: c.timezone, membershipId: null },
          { bookingId: c.bookingId, endAt: c.deadline.toISOString() },
          now,
        )
        // System action: no actor membership (audit_log.actor_membership_id is nullable).
        await tx.insert(auditLog).values({
          tenantId: c.tenantId,
          actorMembershipId: null,
          action: 'walkin.auto_closed',
          entityType: 'booking',
          entityId: c.bookingId,
          before: { endsAt: null },
          after: {
            endsAt: c.deadline.toISOString(),
            limitMinutes: c.limitMinutes,
            atClosing: c.atClosing,
            total: total.toFixed(2),
          },
        })
      })
      closed++
    } catch (e) {
      // Already checked out meanwhile, or no longer closeable: leave it for staff.
      failed++
      console.error('[auto-close-walkins] skipped a booking:', e instanceof Error ? e.message : 'unknown')
    }
  }
  return { closed, failed }
}

/** Per-tenant gap between request-triggered sweeps, per server instance. */
const SWEEP_INTERVAL_MS = 30_000
/**
 * Most tabs one request-triggered sweep closes. The sweep runs inline on a read
 * (the Sessions list and the alarm poll), so a long gap must not make that read
 * wait for dozens of sequential transactions; the rest close on the next sweep.
 * The cron / manual run keeps the larger default.
 */
export const REQUEST_SWEEP_LIMIT = 10
const lastSweep = new Map<string, number>()

/**
 * Request-triggered sweep: close this tenant's overdue open-tab walk-ins when
 * someone reads the live walk-in list. There is no scheduler behind it, so a
 * forgotten tab closes on the next read after its deadline, not at it — the
 * bill is still stamped at the deadline (see autoCloseOverdueWalkins).
 *
 * Best effort: throttled per tenant per server instance, and a failure is
 * logged and swallowed so it never breaks the read. Concurrent sweeps are safe
 * because checkout locks the booking row; the loser is skipped.
 */
export async function sweepOverdueWalkinsForTenant(tenantId: string, now: Date = new Date()): Promise<void> {
  const last = lastSweep.get(tenantId)
  if (last !== undefined && now.getTime() - last < SWEEP_INTERVAL_MS) return
  lastSweep.set(tenantId, now.getTime())
  try {
    await autoCloseOverdueWalkins({ tenantId, now, limit: REQUEST_SWEEP_LIMIT })
  } catch (e) {
    console.error('[auto-close-walkins] sweep failed:', e instanceof Error ? e.message : 'unknown')
  }
}

/** Test hook: forget the throttle. */
export function resetWalkinSweepThrottle(): void {
  lastSweep.clear()
}
