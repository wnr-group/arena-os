'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { checkoutWalkin, extendWalkin, previewWalkinCheckout } from '@/lib/actions/bookings'
import { formatCountdown } from '@/lib/booking/countdown'
import { formatMoney, timeInZone } from '@/lib/format'

const QUICK_EXTEND_MINUTES = [15, 30, 60]

/**
 * A timed walk-in's "Extend / check out" dialog (M21 #5) — one screen for
 * both actions, since they're the same decision from the operator's side:
 * "is this session done, or does it need more time?"
 *
 * Checking out is only offered while the (possibly-extended) committed end
 * hasn't passed yet — past it, the server refuses with "Extend the session
 * before checking out" and this dialog surfaces that as guidance right next
 * to the Extend control, not as a dead-end error. Billed time is always the
 * committed end (extensions included), never however long the session
 * actually ran — see lib/booking/walkin.ts's resolveCheckoutWindow.
 *
 * M22 follow-up: checking out no longer raises the invoice itself — it only
 * prices/freezes the session, then hands off to the same POS bill screen a
 * reserved booking uses (/pos/[bookingId]) for review/discount before the
 * bill is actually raised. See checkoutWalkin's own doc comment
 * (lib/actions/bookings.ts).
 */
export function TimedWalkinDialog({
  booking,
  timeZone,
  currency,
  onClose,
}: {
  booking: {
    bookingId: string
    bookingNumber: string
    customerName: string | null
    customerPhone: string | null
    resourceName: string
    startsAt: string
    committedEndAt: string
    /** M21 per-head #4: gates the Players control below. */
    pricingMode?: string | null
    headCount?: number | null
    minPlayers?: number
  }
  timeZone: string
  currency: string
  onClose: () => void
}) {
  useBodyScrollLock()
  const router = useRouter()

  const [committedEndAt, setCommittedEndAt] = useState(booking.committedEndAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])
  const { text: countdownText, overdue } = formatCountdown(committedEndAt, now)

  const [addMinutes, setAddMinutes] = useState(15)
  const [extendError, setExtendError] = useState<string | null>(null)
  const [extending, startExtend] = useTransition()

  const isPerHead = booking.pricingMode === 'per_head'
  // M21 per-head #4: an in-progress edit — travels with the preview, only
  // ever WRITTEN by checkoutWalkin itself at confirm, same discipline
  // committedEndAt/extend already has.
  const [headCount, setHeadCount] = useState(booking.headCount ?? booking.minPlayers ?? 1)
  const minPlayers = booking.minPlayers ?? 1

  const [preview, setPreview] = useState<{ total: number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkingOut, startCheckout] = useTransition()

  // Re-priced whenever the committed end moves (an extend), the head count
  // is edited, or the clock ticks past it — same previewWalkinCheckout call
  // checkoutWalkin itself makes, so the number on screen is what actually
  // gets billed.
  useEffect(() => {
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    previewWalkinCheckout({
      bookingId: booking.bookingId,
      headCount: isPerHead ? headCount : undefined,
    }).then((r) => {
      if (cancelled) return
      setPreviewLoading(false)
      if (r.error || r.total === undefined) {
        setPreviewError(r.error ?? 'Could not price this session.')
        setPreview(null)
        return
      }
      setPreview({ total: r.total })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.bookingId, committedEndAt, headCount, Math.floor(now / 15_000)])

  function extend(minutes: number) {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setExtendError('Enter a whole number of minutes.')
      return
    }
    setExtendError(null)
    startExtend(async () => {
      const r = await extendWalkin({ bookingId: booking.bookingId, addMinutes: minutes })
      if (r.error || !r.committedEndAt) {
        setExtendError(r.error ?? 'Could not extend this session.')
        return
      }
      setCommittedEndAt(r.committedEndAt)
      toast.success(`Extended by ${minutes} min — now ends ${timeInZone(r.committedEndAt, timeZone)}.`)
    })
  }

  function checkout() {
    setCheckoutError(null)
    startCheckout(async () => {
      const r = await checkoutWalkin({
        bookingId: booking.bookingId,
        headCount: isPerHead ? headCount : undefined,
      })
      if (r.error || !r.bookingId) {
        setCheckoutError(r.error ?? 'Could not check out this session.')
        return
      }
      toast.success(`${booking.bookingNumber} checked out — review the bill.`)
      router.push(`/pos/${booking.bookingId}`)
    })
  }

  const busy = extending || checkingOut

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={busy ? undefined : onClose}
      role="alertdialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">{booking.resourceName} — timed session</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {booking.customerName || booking.customerPhone || 'Walk-in'} · started {timeInZone(booking.startsAt, timeZone)}
        </p>

        <div
          className={`mt-4 flex items-center justify-between rounded-lg border p-3 ${
            overdue ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-accent/40'
          }`}
        >
          <span className={`flex items-center gap-1.5 text-sm font-semibold ${overdue ? 'text-destructive' : 'text-foreground'}`}>
            <Clock size={15} /> {countdownText}
          </span>
          <span className="text-xs text-muted-foreground">Ends {timeInZone(committedEndAt, timeZone)}</span>
        </div>

        <label className="mt-4 block text-sm font-medium text-foreground">Extend by</label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {QUICK_EXTEND_MINUTES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => extend(m)}
              disabled={busy}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              +{m} min
            </button>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={1440}
              value={addMinutes}
              onChange={(e) => setAddMinutes(Number(e.target.value))}
              disabled={busy}
              className="w-16 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => extend(addMinutes)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {extending && <Loader2 size={13} className="animate-spin" />} Extend
            </button>
          </div>
        </div>
        {extendError && <p className="mt-1.5 text-sm text-destructive">{extendError}</p>}

        {isPerHead && (
          <>
            <label className="mt-4 block text-sm font-medium text-foreground">Players</label>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setHeadCount((h) => Math.max(minPlayers, h - 1))}
                disabled={busy || headCount <= minPlayers}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
              >
                −
              </button>
              <span className="flex-1 rounded-lg border border-border bg-accent/40 px-3 py-2 text-center text-base font-semibold text-foreground">
                {headCount}
              </span>
              <button
                type="button"
                onClick={() => setHeadCount((h) => h + 1)}
                disabled={busy}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Editing re-prices the whole session — minimum {minPlayers}.
            </p>
          </>
        )}

        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Committed-time charge</span>
            {previewLoading && <Loader2 size={14} className="animate-spin" />}
          </div>
          {overdue ? (
            <p className="mt-1.5 text-sm text-foreground">
              This session&apos;s committed time is up. Extend it above before checking out — the bill will always match
              the committed time plus any extensions, never a silent overstay charge.
            </p>
          ) : previewError ? (
            <p className="mt-1 text-sm text-destructive">{previewError}</p>
          ) : (
            <>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                {preview ? formatMoney(preview.total, currency) : '—'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                For the full committed session, whether it runs the whole way or ends early. Food/orders fold into
                the same bill.
              </p>
            </>
          )}
        </div>

        {checkoutError && <p className="mt-3 text-sm text-destructive">{checkoutError}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || overdue || previewLoading || !preview}
            onClick={checkout}
          >
            {checkingOut && <Loader2 size={14} className="animate-spin" />}
            Check out
          </button>
        </div>
      </div>
    </div>
  )
}
