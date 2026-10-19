import 'server-only'
import { getPublicWorkingHours } from './public-availability'

/**
 * Weekdays (0 = Sunday) the branch is closed, from its working hours — one
 * cheap read, used to strike closed days out of the long storefront date
 * picker. Deliberately NOT a per-date availability query: only the selected
 * date's availability is ever fetched.
 */
export async function closedWeekdaysOf(tenantId: string, branchId: string): Promise<number[]> {
  try {
    const hours = await getPublicWorkingHours(tenantId, branchId)
    return hours.filter((h) => h.isClosed).map((h) => h.dayOfWeek)
  } catch {
    return [] // purely cosmetic: a failed read just means no day is struck out
  }
}
