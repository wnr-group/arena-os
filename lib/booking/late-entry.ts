import { prettyDate } from '@/lib/format'
import { todayInZone } from './time'

/**
 * "Recorded 30 Sep 2026, for a session on 24 Sep 2026" — the audit-relevant
 * fact behind a backdated entry (M28 #4). Client-safe; both inputs are
 * ISO strings or Dates, rendered in the tenant's own timezone.
 */
export function lateEntryLabel(recordedAt: string | Date, sessionStart: string | Date, timeZone: string): string {
  const day = (d: string | Date) => prettyDate(todayInZone(timeZone, new Date(d)), timeZone)
  return `Recorded ${day(recordedAt)}, for a session on ${day(sessionStart)}`
}
