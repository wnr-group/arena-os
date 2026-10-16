import Link from 'next/link'

const chipBase = 'inline-block whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium transition'
const chipOn = 'border-primary bg-primary text-primary-foreground'
const chipOff = 'border-border bg-background hover:bg-muted'

export type RangeChip = { key: string; label: string; href: string; active: boolean }

/**
 * The quick-range chip row shared by the report filters (day-based
 * DateRangeFilter, month-based PeriodRangeFilter). Presentational only: each
 * filter decides which chips exist, where they link and which is active.
 */
export function RangeChips({ chips }: { chips: RangeChip[] }) {
  return (
    <nav aria-label="Quick date range">
      <ul className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <li key={c.key}>
            <Link
              href={c.href}
              aria-current={c.active ? 'page' : undefined}
              className={`${chipBase} ${c.active ? chipOn : chipOff}`}
            >
              {c.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
