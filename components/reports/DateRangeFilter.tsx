'use client'

import { useId, useState, useTransition, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { RANGE_LABELS, REPORT_PRESETS, matchingReportPresets, resolvePresetDates } from '@/lib/booking/ranges'

const chipBase = 'inline-block whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium transition'
const chipOn = 'border-primary bg-primary text-primary-foreground'
const chipOff = 'border-border bg-background hover:bg-muted'

/**
 * Date-range filter shared by the reports pages: quick-range chips plus custom
 * From/To. Everything is the same `?from=&to=` contract, applied as a soft RSC
 * navigation.
 *
 * - Chips are plain <Link>s to ?from=&to= (shareable, no new URL contract). The
 *   preset definitions are the bookings page's (lib/booking/ranges.ts), resolved
 *   against `today` — the TENANT's today, supplied by the server.
 * - The active chip is derived by comparing the current from/to with each
 *   preset's range, so a pasted URL highlights correctly and a custom range
 *   highlights none.
 * - Chips and Apply keep every other query param (e.g. `channel`) and reset
 *   `page`: a new range is a fresh look, not page 3 of the old one.
 */
export function DateRangeFilter({
  basePath,
  from,
  to,
  today,
}: {
  basePath: string
  from: string
  to: string
  today: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const uid = useId()
  const [fromVal, setFromVal] = useState(from)
  const [toVal, setToVal] = useState(to)
  const [pending, startTransition] = useTransition()

  // A chip click (or back/forward) changes the props without remounting, so
  // re-seed the inputs from the URL's range whenever it changes.
  const [seen, setSeen] = useState(`${from}|${to}`)
  if (seen !== `${from}|${to}`) {
    setSeen(`${from}|${to}`)
    setFromVal(from)
    setToVal(to)
  }

  const activePresets = matchingReportPresets(from, to, today)

  function hrefFor(f: string, t: string): string {
    const params = new URLSearchParams(searchParams)
    params.set('from', f)
    params.set('to', t)
    params.delete('page')
    return `${basePath}?${params.toString()}`
  }

  function apply(e: FormEvent) {
    e.preventDefault()
    startTransition(() => {
      router.push(hrefFor(fromVal, toVal))
    })
  }

  return (
    <form onSubmit={apply} className="mt-6 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <nav aria-label="Quick date range">
        <ul className="flex flex-wrap gap-2">
          {REPORT_PRESETS.map((p) => {
            const r = resolvePresetDates(p, today)
            const active = activePresets.includes(p)
            return (
              <li key={p}>
                <Link
                  href={hrefFor(r.fromDate, r.toDate)}
                  aria-current={active ? 'page' : undefined}
                  className={`${chipBase} ${active ? chipOn : chipOff}`}
                >
                  {RANGE_LABELS[p]}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-from`} className="text-xs font-medium text-muted-foreground">
            From
          </label>
          <input
            id={`${uid}-from`}
            type="date"
            value={fromVal}
            // Never later than To, and never in the future.
            max={toVal && toVal < today ? toVal : today}
            onChange={(e) => setFromVal(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-to`} className="text-xs font-medium text-muted-foreground">
            To
          </label>
          <input
            id={`${uid}-to`}
            type="date"
            value={toVal}
            max={today}
            onChange={(e) => setToVal(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {pending ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </form>
  )
}
