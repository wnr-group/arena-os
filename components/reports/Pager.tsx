import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/** Where one rendered page sits within its full list. */
export type PageInfo = {
  /** 1-based, and already clamped into [1, pageCount]. */
  page: number
  pageSize: number
  /** Rows in the entire list, not just the page. */
  total: number
  /** At least 1, so an empty list reads "page 1 of 1", not "1 of 0". */
  pageCount: number
}

/** Requested page number, from a query string. Absent, invalid or out-of-range → page 1. */
export function pageInfo(requested: string | undefined, total: number, pageSize: number): PageInfo {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const asNumber = Number(requested)
  const page = Number.isInteger(asNumber) && asNumber >= 1 ? Math.min(asNumber, pageCount) : 1
  return { page, pageSize, total, pageCount }
}

/**
 * Previous / next paging for one report table.
 *
 * A `<Link>`-based pager, not client state: paging is a navigation, so the
 * page number lives in the URL (shareable, correct on back/forward) and the
 * table stays a plain server-rendered slice — no fetch, no spinner. Mirrors
 * components/portal/Pager.tsx.
 */
export function Pager({
  info,
  label,
  hrefFor,
}: {
  info: PageInfo
  /** Names the table for screen readers: "Daily breakdown pages". */
  label: string
  /** Build the URL for a page number, preserving everything else (date range, etc). */
  hrefFor: (page: number) => string
}) {
  if (info.pageCount <= 1) return null

  const first = (info.page - 1) * info.pageSize + 1
  const last = Math.min(info.page * info.pageSize, info.total)
  const hasPrev = info.page > 1
  const hasNext = info.page < info.pageCount

  return (
    <nav
      aria-label={`${label} pages`}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="text-xs text-muted-foreground">
        Showing {first}–{last} of {info.total}
      </p>

      <div className="flex items-center gap-1">
        <Step href={hasPrev ? hrefFor(info.page - 1) : null} rel="prev" label="Previous">
          <ChevronLeft size={16} aria-hidden />
          <span>Previous</span>
        </Step>

        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          Page {info.page} of {info.pageCount}
        </span>

        <Step href={hasNext ? hrefFor(info.page + 1) : null} rel="next" label="Next">
          <span>Next</span>
          <ChevronRight size={16} aria-hidden />
        </Step>
      </div>
    </nav>
  )
}

function Step({
  href,
  rel,
  label,
  children,
}: {
  href: string | null
  rel: 'prev' | 'next'
  label: string
  children: React.ReactNode
}) {
  const shape = 'inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors'

  if (!href) {
    return (
      <span aria-disabled="true" className={`${shape} border-border/50 text-muted-foreground/50`}>
        {children}
      </span>
    )
  }

  return (
    <Link href={href} rel={rel} aria-label={`${label} page`} className={`${shape} border-border hover:bg-muted`}>
      {children}
    </Link>
  )
}
