import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { waitlistEntries } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { getReservationSettingsCore } from '@/lib/reservations/settings'
import { estimateNewPartyWait, type WaitEstimate } from './service'

export type WaitlistRow = {
  id: string
  name: string
  phone: string | null
  partySize: number
  quotedWaitMinutes: number | null
  notes: string | null
  status: string
  createdAt: Date
  notifiedAt: Date | null
}

export function isWaitlistEnabled(ctx: ActiveContext): Promise<boolean> {
  return withUser(ctx.user.id, async (tx) => (await getReservationSettingsCore(tx, ctx.tenant.id)).waitlistEnabled)
}

/** The live queue (waiting + notified), longest-waiting first. */
export function listActiveWaitlist(ctx: ActiveContext, branchId: string): Promise<WaitlistRow[]> {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: waitlistEntries.id,
        name: waitlistEntries.name,
        phone: waitlistEntries.phone,
        partySize: waitlistEntries.partySize,
        quotedWaitMinutes: waitlistEntries.quotedWaitMinutes,
        notes: waitlistEntries.notes,
        status: waitlistEntries.status,
        createdAt: waitlistEntries.createdAt,
        notifiedAt: waitlistEntries.notifiedAt,
      })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.tenantId, ctx.tenant.id),
          eq(waitlistEntries.branchId, branchId),
          inArray(waitlistEntries.status, ['waiting', 'notified']),
        ),
      )
      .orderBy(asc(waitlistEntries.createdAt)),
  )
}

export function getWaitEstimate(ctx: ActiveContext, branchId: string): Promise<WaitEstimate> {
  return withUser(ctx.user.id, (tx) => estimateNewPartyWait(tx, ctx.tenant.id, branchId))
}
