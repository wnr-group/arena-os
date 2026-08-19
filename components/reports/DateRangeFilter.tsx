'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

/** Date-range filter shared by the reports pages — pushes ?from=&to= via the router so applying is a soft RSC navigation, not a full page reload. */
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
  const [fromVal, setFromVal] = useState(from)
  const [toVal, setToVal] = useState(to)
  const [pending, startTransition] = useTransition()

  function apply(e: FormEvent) {
    e.preventDefault()
    startTransition(() => {
      router.push(`${basePath}?from=${fromVal}&to=${toVal}`)
    })
  }

  return (
    <form onSubmit={apply} className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-1">
        <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
          From
        </label>
        <input
          id="from"
          type="date"
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
    </form>
  )
}
