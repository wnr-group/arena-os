import Link from 'next/link'
import { RANGE_PRESETS, type RangePreset, type ResolvedRange } from '@/lib/booking/ranges'

export const RANGE_LABELS: Record<RangePreset, string> = {
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  month: 'This month',
  last3m: 'Last 3 months',
  lastyear: 'Last year',
}

function shortDate(dateStr: string, withYear: boolean): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** "6 Oct – 12 Oct 2026" (local dates in the tenant zone). */
export function rangeSpan(range: Pick<ResolvedRange, 'fromDate' | 'toDate'>): string {
  return range.fromDate === range.toDate
    ? shortDate(range.fromDate, true)
    : `${shortDate(range.fromDate, false)} – ${shortDate(range.toDate, true)}`
}

/** "Last 7 days · 6 Oct – 12 Oct 2026" */
export function rangeSummary(range: Pick<ResolvedRange, 'preset' | 'fromDate' | 'toDate'>): string {
  return `${RANGE_LABELS[range.preset]} · ${rangeSpan(range)}`
}

const chipBase = 'inline-block shrink-0 whitespace-nowrap rounded-md border px-3.5 py-1.5 text-sm font-medium transition'
const chipOn = 'border-primary bg-primary text-primary-foreground'
const chipOff = 'border-border bg-background hover:bg-muted'

/**
 * Today + the range presets as plain links, so the selection lives in the URL
 * (shareable, back-button friendly). A plain ?date= view leaves every chip
 * unhighlighted.
 */
export function RangePresetBar({ active, todayActive }: { active: RangePreset | null; todayActive: boolean }) {
  return (
    <nav aria-label="Date range" className="-mx-6 mt-4 overflow-x-auto px-6 pb-1">
      <ul className="flex w-max gap-2">
        <li>
          <Link
            href="/bookings"
            aria-current={todayActive ? 'page' : undefined}
            className={`${chipBase} ${todayActive ? chipOn : chipOff}`}
          >
            Today
          </Link>
        </li>
        {RANGE_PRESETS.map((p) => (
          <li key={p}>
            <Link
              href={`/bookings?range=${p}`}
              aria-current={active === p ? 'page' : undefined}
              className={`${chipBase} ${active === p ? chipOn : chipOff}`}
            >
              {RANGE_LABELS[p]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
