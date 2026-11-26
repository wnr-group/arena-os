'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTransition, type ReactNode } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { RangePresetBar } from './RangePresetBar'
import type { RangePreset } from '@/lib/booking/ranges'

/**
 * Multi-day bookings page shell (M34 #3): header, preset chips and the
 * resolved range. Day-only controls (prev/next, date input, Walk-in) are
 * omitted; the list itself (#4) is passed in as children.
 */
export function BookingsRangeView({
  branchName,
  preset,
  summary,
  counterButton,
  counterSales,
  children,
}: {
  branchName: string
  preset: RangePreset
  summary: string
  counterButton?: ReactNode
  counterSales?: ReactNode
  children?: ReactNode
}) {
  const router = useRouter()
  const [refreshing, startRefresh] = useTransition()
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">Bookings</h1>
          <p className="text-sm text-muted-foreground">
            {branchName} · {summary}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => startRefresh(() => router.refresh())}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-accent px-3 py-2 text-base font-medium text-accent-foreground transition hover:bg-accent/70 disabled:opacity-50"
            aria-label="Refresh bookings"
            title="Refresh"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <Link
            href="/bookings/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-base font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus size={16} /> New booking
          </Link>
          {counterButton}
        </div>
      </div>
      <RangePresetBar active={preset} todayActive={false} />
      {counterSales}
      {children}
    </div>
  )
}
