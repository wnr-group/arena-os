/**
 * DB loader for a tenant's active happy-hour rules, in the shape apply.ts /
 * lib/billing/elapsed-time.ts expect.
 *
 * Split out of lib/booking/walkin.ts (M21 #2's private loadActiveHappyHourRules)
 * so lib/booking/service.ts's priceBookingSlots (M23 #1, reserved bookings)
 * can share the exact same query instead of a third, potentially-drifting
 * copy — walkin.ts imports it back from here too. Loaded ONCE per pricing
 * call and matched in memory against every slot/segment; see each caller for
 * how "once" is enforced across multiple slots.
 */
import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { happyHours } from '@/db/schema'
import type { HappyHourRule } from './apply'

type Db = NodePgDatabase<typeof schema>

export async function loadActiveHappyHourRules(tx: Db, tenantId: string): Promise<HappyHourRule[]> {
  return tx
    .select({
      id: happyHours.id,
      name: happyHours.name,
      daysOfWeek: happyHours.daysOfWeek,
      startTime: happyHours.startTime,
      endTime: happyHours.endTime,
      discountType: happyHours.discountType,
      discountValue: happyHours.discountValue,
      isActive: happyHours.isActive,
    })
    .from(happyHours)
    .where(and(eq(happyHours.tenantId, tenantId), eq(happyHours.isActive, true)))
}
