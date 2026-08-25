import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { happyHours } from '@/db/schema'
import type { HappyHourRule } from './apply'

/**
 * Active happy-hour rules for the public ordering page's price preview — same
 * select shape lib/orders/service.ts:createOrderCore reads at order-creation
 * time, so activeHappyHours()/applyHappyHour() (both pure, in ./apply.ts) can
 * be reused as-is to compute the exact same discounted price a browsing
 * customer sees and what they end up billed.
 */
export async function getPublicActiveHappyHourRules(tenantId: string): Promise<HappyHourRule[]> {
  return withPublicTenant(tenantId, (tx) =>
    tx
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
      .where(and(eq(happyHours.tenantId, tenantId), eq(happyHours.isActive, true))),
  )
}
