'use client'

import { useEffect, useState } from 'react'
import { Flame, X } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { LiveHappyHourBanner } from '@/lib/happy-hours/public'

function discountLabel(happyHour: LiveHappyHourBanner, currency: string): string {
  return happyHour.discountType === 'percentage'
    ? `${Number(happyHour.discountValue)}% OFF`
    : `${formatMoney(happyHour.discountValue, currency)} OFF`
}

function splitClock(ms: number): [number, number, number] {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(totalSeconds / 3600), Math.floor((totalSeconds % 3600) / 60), totalSeconds % 60]
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A floating "Happy Hour is live" badge with a digital-clock countdown to
 * when today's window closes — mounted once per public layout (see
 * app/(public)/layout.tsx and the tenant branch of app/page.tsx) so it
 * follows the customer across every storefront page without each page
 * fetching happy-hour data itself.
 *
 * `happyHour` is computed server-side (getLiveHappyHourBanner) from the SAME
 * activeHappyHours() rule pricing already runs off — this never re-derives
 * "is it active" itself, only ticks the countdown to the instant it was told.
 * Renders nothing when null, or once the countdown reaches the server-given
 * endsAt (a page navigation re-fetches fresh server data anyway, so this
 * never needs to poll for a NEW happy hour starting).
 */
export function HappyHourFloatingWidget({
  happyHour,
  currency,
}: {
  happyHour: LiveHappyHourBanner | null
  currency: string
}) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [dismissedId, setDismissedId] = useState<string | null>(null)

  useEffect(() => {
    if (!happyHour) return
    const endsAt = new Date(happyHour.endsAt).getTime()
    const tick = () => setRemainingMs(endsAt - Date.now())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [happyHour?.endsAt])

  if (!happyHour || happyHour.id === dismissedId) return null
  if (remainingMs !== null && remainingMs <= 0) return null

  const [h, m, s] = splitClock(remainingMs ?? new Date(happyHour.endsAt).getTime() - Date.now())

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 sm:inset-x-auto sm:right-5 sm:justify-end sm:px-0">
      <div className="animate-happy-hour-float pointer-events-auto relative flex max-w-[calc(100vw-2rem)] items-center gap-3 overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 px-4 py-3 shadow-2xl shadow-orange-900/40 sm:px-4.5">
        {/* Glassy light sweep, purely decorative. */}
        <span
          aria-hidden="true"
          className="animate-happy-hour-shine pointer-events-none absolute inset-y-0 left-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent"
        />

        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white shadow-inner">
          <Flame size={18} className="animate-pulse" />
        </span>

        <div className="relative min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-white/90">
            <span className="relative flex size-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80" />
              <span className="relative inline-flex size-1.5 rounded-full bg-white" />
            </span>
            <span className="truncate">Happy Hour Live · {discountLabel(happyHour, currency)}</span>
          </p>
          <p className="truncate text-sm font-bold text-white">{happyHour.name}</p>
        </div>

        {/* Premium digital-clock countdown. */}
        <div className="relative flex shrink-0 items-center gap-0.5 rounded-xl bg-black/30 px-2.5 py-1.5 shadow-inner ring-1 ring-white/10">
          {[h, m, s].map((unit, i) => (
            <span key={i} className="flex items-center">
              {i > 0 && <span className="px-0.5 font-mono text-sm font-bold text-white/40">:</span>}
              <span className="min-w-[1.5ch] text-center font-mono text-base font-bold tabular-nums text-white [text-shadow:0_0_10px_rgba(255,255,255,0.55)]">
                {pad(unit)}
              </span>
            </span>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setDismissedId(happyHour.id)}
          aria-label="Dismiss happy hour banner"
          className="relative shrink-0 rounded-full p-1 text-white/70 transition hover:bg-white/15 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
