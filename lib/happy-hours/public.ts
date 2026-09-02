import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { happyHours } from '@/db/schema'
import { activeHappyHours, type HappyHourRule } from './apply'
import { todayInZone, zonedTimeToUtc } from '@/lib/booking/time'

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

export type LiveHappyHourBanner = {
  id: string
  name: string
  discountType: HappyHourRule['discountType']
  discountValue: string
  /** ISO instant when today's window closes — the countdown widget's target. */
  endsAt: string
}

/**
 * The single happy-hour rule to surface on the customer-facing floating
 * banner (components/public-booking/HappyHourFloatingWidget.tsx), or null
 * when nothing is live right now. Same day/time math as activeHappyHours()
 * — this file has no rule of its own beyond "what's currently live" — but
 * unlike that pricing-facing helper, this also derives a real end INSTANT
 * (today's date + the rule's endTime, in the tenant's timezone) for the
 * widget to count down to, since activeHappyHours only ever compares
 * `HH:mm` strings and never produces one.
 *
 * When more than one rule overlaps, the one running longest (latest end)
 * wins, so the banner never disappears while ANY discount is still active —
 * a different tie-break than applyHappyHour's "biggest discount", which
 * needs a base price this banner doesn't have.
 */
export async function getLiveHappyHourBanner(
  tenantId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<LiveHappyHourBanner | null> {
  const rules = await getPublicActiveHappyHourRules(tenantId)
  const live = activeHappyHours(rules, now, timezone)
  if (live.length === 0) return null

  const primary = live.reduce((a, b) => (b.endTime.slice(0, 5) > a.endTime.slice(0, 5) ? b : a))
  const endsAt = zonedTimeToUtc(todayInZone(timezone, now), primary.endTime.slice(0, 5), timezone)

  return {
    id: primary.id,
    name: primary.name,
    discountType: primary.discountType,
    discountValue: String(primary.discountValue),
    endsAt: endsAt.toISOString(),
  }
}
