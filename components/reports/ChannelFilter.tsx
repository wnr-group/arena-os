'use client'

import { useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Walk-in vs reserved channel filter (M21 #7) — same URL-driven pattern as
 * DateRangeFilter, so applying is a soft RSC navigation, not a full reload.
 * Changing it navigates immediately (no separate Apply button): unlike the
 * date range, there's no in-between state to type through.
 */
export function ChannelFilter({ basePath }: { basePath: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const value = searchParams.get('channel') ?? 'all'

  function apply(next: string) {
    const params = new URLSearchParams(searchParams)
    if (next === 'all') params.delete('channel')
    else params.set('channel', next)
    // A channel change is a fresh look at the data, not a continuation of
    // whatever page of the daily table was open.
    params.delete('page')
    startTransition(() => {
      router.push(`${basePath}?${params.toString()}`)
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="channel" className="text-xs font-medium text-muted-foreground">
        Channel
      </label>
      <select
        id="channel"
        value={value}
        disabled={pending}
        onChange={(e) => apply(e.target.value)}
        className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-60"
      >
        <option value="all">All</option>
        <option value="walkin">Walk-in</option>
        <option value="reserved">Reserved</option>
      </select>
    </div>
  )
}
