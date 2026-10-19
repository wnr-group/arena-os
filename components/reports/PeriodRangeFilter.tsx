'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { PAYROLL_PRESETS, PAYROLL_PRESET_LABELS, matchingPayrollPresets, resolvePayrollPreset } from '@/lib/reports/period-presets'
import { RangeChips } from './RangeChips'

/**
 * Month-range filter — the payroll report's sibling of DateRangeFilter: month
 * quick-range chips plus custom From/To, all the same ?from=&to= ('YYYY-MM'
 * each) contract. Chips are plain links resolved against `maxPeriod` (the
 * tenant's current period); the active chip is derived from from/to.
 */
export function PeriodRangeFilter({
  basePath,
  from,
  to,
  maxPeriod,
}: {
  basePath: string
  from: string
  to: string
  maxPeriod: string
}) {
  const router = useRouter()
  const [fromVal, setFromVal] = useState(from)
  const [toVal, setToVal] = useState(to)
  const [pending, startTransition] = useTransition()

  // A chip click (or back/forward) changes the props without remounting, so
  // re-seed the inputs whenever the URL's range changes.
  const [seen, setSeen] = useState(`${from}|${to}`)
  if (seen !== `${from}|${to}`) {
    setSeen(`${from}|${to}`)
    setFromVal(from)
    setToVal(to)
  }

  const activePresets = matchingPayrollPresets(from, to, maxPeriod)

  function apply(e: FormEvent) {
    e.preventDefault()
    startTransition(() => {
      router.push(`${basePath}?from=${fromVal}&to=${toVal}`)
    })
  }

  return (
    <form onSubmit={apply} className="mt-6 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <RangeChips
        chips={PAYROLL_PRESETS.map((p) => {
          const r = resolvePayrollPreset(p, maxPeriod)
          return {
            key: p,
            label: PAYROLL_PRESET_LABELS[p],
            href: `${basePath}?from=${r.from}&to=${r.to}`,
            active: activePresets.includes(p),
          }
        })}
      />
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            From
          </label>
          <input
            id="from"
            type="month"
            value={fromVal}
            max={toVal}
            onChange={(e) => setFromVal(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            To
          </label>
          <input
            id="to"
            type="month"
            value={toVal}
            max={maxPeriod}
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
