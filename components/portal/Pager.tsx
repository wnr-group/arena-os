import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PortalPageInfo } from '@/lib/portal/bookings'

/**
 * Previous / next paging for one portal list section.
 *
 * ── Links, not buttons ──────────────────────────────────────────────────────
 *
 * Paging is a navigation, so it is `<Link>`s carrying the page in the query
 * string rather than client state. That keeps the whole section a server
 * component — no 'use client', no fetch on the client, no loading spinner — and
 * it means a page of history is a real URL: shareable, bookmarkable, and
 * correct on back/forward. The reader clamps whatever arrives, so a hand-edited
 * ?past=99 lands on the last real page rather than an empty section.
 *
 * ── Both lists page independently ───────────────────────────────────────────
 *
 * `hrefFor` is supplied by the page, which owns the other section's parameter
 * and preserves it. Paging through history must not silently reset Upcoming to
 * page 1 — the two sections are read side by side, and losing your place in one
 * because you moved in the other is the kind of small wrongness that makes a
 * portal feel broken.
 */
export function Pager({
  info,
  label,
  hrefFor,
}: {
  info: PortalPageInfo
  /** Names the section for screen readers: "Past bookings pages". */
  label: string
  /** Build the URL for a page number, preserving everything else. */
  hrefFor: (page: number) => string
}) {
  // Nothing to page through. Rendering "page 1 of 1" under every short list
  // would be noise on the screen most customers actually see.
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

/**
 * One end of the pager.
 *
 * A disabled step is a <span>, not a greyed-out link: there is no page to go
 * to, so there should be nothing to focus, nothing to middle-click and nothing
 * for a screen reader to announce as actionable.
 */
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
  const shape =
    'inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors'

  if (!href) {
    return (
      <span
        aria-disabled="true"
        className={`${shape} border-border/50 text-muted-foreground/50`}
      >
        {children}
      </span>
    )
  }

  return (
    <Link
      href={href}
      rel={rel}
      aria-label={`${label} page`}
      // scroll={false} would leave the viewport on the section you were reading,
      // but the two sections are stacked — paging Past while parked at the top
      // would move rows you cannot see. The href carries a fragment instead, so
      // the browser lands on the section that actually changed.
      className={`${shape} border-border hover:bg-muted`}
    >
      {children}
    </Link>
  )
}
