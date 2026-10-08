'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, Loader2, PencilLine, X } from 'lucide-react'
import { toast } from 'sonner'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { checkoutWalkin, correctWalkinEndTime, extendWalkin, previewWalkinCheckout } from '@/lib/actions/bookings'
import { formatCountdown } from '@/lib/booking/countdown'
import { resolveCorrectedEnd } from '@/lib/booking/walkin-end-time'
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
    /** M29 #6: a board-with-surcharge walk-in (extra rate frozen at start)
     *  also gets the Players control — no floor, unlike per_head. */
    extraPlayerRateApplied?: string | null
    includedPlayers?: number
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

  // M31 #2: "Fix end time" — set the committed end to an absolute time. The
  // input is pre-filled with the CURRENT end (HH:mm in the branch timezone)
  // and follows it whenever it moves (an extend, or a successful correction).
  const [fixTime, setFixTime] = useState(() => timeInZone(booking.committedEndAt, timeZone))
  const [fixError, setFixError] = useState<string | null>(null)
  const [fixing, startFix] = useTransition()
  useEffect(() => {
    setFixTime(timeInZone(committedEndAt, timeZone))
  }, [committedEndAt, timeZone])
  const fixTarget = resolveCorrectedEnd(booking.startsAt, fixTime, timeZone)
  const fixUnchanged = fixTime === timeInZone(committedEndAt, timeZone)

  const isPerHead = booking.pricingMode === 'per_head'
  const isBoard = !isPerHead && booking.extraPlayerRateApplied != null
  const takesPlayers = isPerHead || isBoard
  // M21 per-head #4: an in-progress edit — travels with the preview, only
  // ever WRITTEN by checkoutWalkin itself at confirm, same discipline
  // committedEndAt/extend already has.
  const [headCount, setHeadCount] = useState(
    booking.headCount ?? (isBoard ? (booking.includedPlayers ?? 1) : (booking.minPlayers ?? 1)),
  )
  // A surcharge board has no real floor: fewer players than included just
  // means no surcharge.
  const minPlayers = isBoard ? 1 : (booking.minPlayers ?? 1)

  const [preview, setPreview] = useState<{ total: number; addonTotal: number } | null>(null)
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
      headCount: takesPlayers ? headCount : undefined,
    }).then((r) => {
      if (cancelled) return
      setPreviewLoading(false)
      if (r.error || r.total === undefined) {
        setPreviewError(r.error ?? 'Could not price this session.')
        setPreview(null)
        return
      }
      setPreview({ total: r.total, addonTotal: r.addonTotal ?? 0 })
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

  function fixEndTime() {
    if (!fixTarget) {
      setFixError('Enter a valid end time.')
      return
    }
    setFixError(null)
    startFix(async () => {
      // The server re-validates everything (after the start, still in the
      // future, within 24h, timed + not yet checked out) and answers with a
      // specific message — shown as-is below.
      const r = await correctWalkinEndTime({ bookingId: booking.bookingId, newEndAt: fixTarget.iso })
      if (r.error || !r.committedEndAt) {
        setFixError(r.error ?? 'Could not change this session’s end time.')
        return
      }
      // Same live re-pricing as an extend: the preview effect is keyed on
      // committedEndAt, so updating it here re-prices the session.
      setCommittedEndAt(r.committedEndAt)
      toast.success(`End time corrected — now ends ${timeInZone(r.committedEndAt, timeZone)}.`)
    })
  }

  function checkout() {
    setCheckoutError(null)
    startCheckout(async () => {
      const r = await checkoutWalkin({
        bookingId: booking.bookingId,
        headCount: takesPlayers ? headCount : undefined,
      })
      if (r.error || !r.bookingId) {
        setCheckoutError(r.error ?? 'Could not check out this session.')
        return
      }
      toast.success(`${booking.bookingNumber} checked out — review the bill.`)
      router.push(`/pos/${booking.bookingId}`)
    })
  }

  const busy = extending || fixing || checkingOut

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={busy ? undefined : onClose}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="timed-walkin-title"
    >
      <div
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-2xl sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b border-border/70 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Timed session</p>
            <h2 id="timed-walkin-title" className="mt-0.5 truncate text-lg font-semibold leading-tight text-foreground">
              {booking.resourceName}
            </h2>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {booking.customerName || booking.customerPhone || 'Walk-in'} · started{' '}
              <span className="tabular-nums">{timeInZone(booking.startsAt, timeZone)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-1.5 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* ── Scrollable body ────────────────────────────────────── */}
        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
          {/* Status */}
          <div
            className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 ${
              overdue ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-accent/40'
            }`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                  overdue ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-primary'
                }`}
              >
                <Clock size={18} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {overdue ? 'Time is up' : 'Time left'}
                </p>
                <p className={`truncate text-base font-bold tabular-nums ${overdue ? 'text-destructive' : 'text-foreground'}`}>
                  {countdownText}
                </p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ends</p>
              <p className="text-base font-bold tabular-nums text-foreground">{timeInZone(committedEndAt, timeZone)}</p>
            </div>
          </div>

          {/* Extend */}
          <section aria-labelledby="walkin-extend-label">
            <h3 id="walkin-extend-label" className="text-sm font-semibold text-foreground">
              Extend time
            </h3>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {QUICK_EXTEND_MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => extend(m)}
                  disabled={busy}
                  className="min-h-11 rounded-xl border border-border bg-background px-3 text-sm font-semibold tabular-nums transition hover:border-primary/50 hover:bg-accent/50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  +{m} min
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type="number"
                  min={1}
                  max={1440}
                  inputMode="numeric"
                  aria-label="Custom minutes to extend by"
                  value={addMinutes}
                  onChange={(e) => setAddMinutes(Number(e.target.value))}
                  disabled={busy}
                  className="min-h-11 w-full rounded-xl border border-border bg-background py-2 pl-3.5 pr-14 text-base font-semibold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-sm text-muted-foreground">
                  min
                </span>
              </div>
              <button
                type="button"
                onClick={() => extend(addMinutes)}
                disabled={busy}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {extending && <Loader2 size={14} className="animate-spin" />} Extend
              </button>
            </div>
            {extendError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {extendError}
              </p>
            )}
          </section>

          {/* M31 #2 — a deliberate correction, visually apart from the routine Extend controls. */}
          <section
            aria-labelledby="walkin-fix-label"
            className="rounded-2xl border border-dashed border-border bg-muted/30 p-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="walkin-fix-label" className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <PencilLine size={14} className="text-muted-foreground" aria-hidden />
                <label htmlFor="walkin-fix-end">Fix end time</label>
              </h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Correction
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <input
                id="walkin-fix-end"
                type="time"
                value={fixTime}
                onChange={(e) => {
                  setFixTime(e.target.value)
                  setFixError(null)
                }}
                disabled={busy}
                className="min-h-11 flex-1 rounded-xl border border-border bg-background px-3.5 py-2 text-base font-semibold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={fixEndTime}
                disabled={busy || fixUnchanged || !fixTarget}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-5 text-sm font-semibold transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {fixing && <Loader2 size={14} className="animate-spin" />} Save
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {fixTarget?.nextDay ? 'Ends the next day. ' : ''}
              Fixes a mistake — set the right end time, earlier or later. For routine extra time use Extend above.
            </p>
            {fixError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {fixError}
              </p>
            )}
          </section>

          {/* Players */}
          {takesPlayers && (
            <section aria-labelledby="walkin-players-label">
              <h3 id="walkin-players-label" className="text-sm font-semibold text-foreground">
                Players
              </h3>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Fewer players"
                  onClick={() => setHeadCount((h) => Math.max(minPlayers, h - 1))}
                  disabled={busy || headCount <= minPlayers}
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-lg font-medium transition hover:bg-muted active:scale-[0.98] disabled:opacity-40"
                >
                  −
                </button>
                <span className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border bg-accent/40 text-lg font-bold tabular-nums text-foreground">
                  {headCount}
                </span>
                <button
                  type="button"
                  aria-label="More players"
                  onClick={() => setHeadCount((h) => h + 1)}
                  disabled={busy}
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-lg font-medium transition hover:bg-muted active:scale-[0.98] disabled:opacity-40"
                >
                  +
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {isBoard
                  ? `Editing re-prices the whole session — ${booking.includedPlayers ?? 1} included, extra players are charged.`
                  : `Editing re-prices the whole session — minimum ${minPlayers}.`}
              </p>
            </section>
          )}

          {/* Charge */}
          <section
            aria-label="Committed-time charge"
            className="rounded-2xl border border-border bg-gradient-to-br from-muted/60 to-muted/20 p-4"
          >
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Committed-time charge</span>
              {previewLoading && <Loader2 size={14} className="animate-spin" aria-label="Pricing" />}
            </div>
            {overdue ? (
              <p className="mt-2 text-sm leading-relaxed text-foreground">
                This session&apos;s committed time is up. Extend it above before checking out — the bill will always
                match the committed time plus any extensions, never a silent overstay charge.
              </p>
            ) : previewError ? (
              <p className="mt-2 text-sm text-destructive">{previewError}</p>
            ) : (
              <>
                <p className="mt-1.5 text-3xl font-bold tabular-nums tracking-tight text-foreground">
                  {preview ? formatMoney(preview.total, currency) : '—'}
                </p>
                {preview && preview.addonTotal > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Includes {formatMoney(preview.addonTotal, currency)} of rented add-ons.
                  </p>
                )}
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  For the full committed session, whether it runs the whole way or ends early. Food/orders fold into
                  the same bill.
                </p>
              </>
            )}
          </section>

          {checkoutError && (
            <p role="alert" className="text-sm text-destructive">
              {checkoutError}
            </p>
          )}
        </div>

        {/* ── Sticky footer ──────────────────────────────────────── */}
        <div className="flex items-center gap-2.5 border-t border-border/70 bg-card px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            className="min-h-11 rounded-xl border border-border px-5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || overdue || previewLoading || !preview}
            onClick={checkout}
          >
            {checkingOut && <Loader2 size={15} className="animate-spin" />}
            Check out
          </button>
        </div>
      </div>
    </div>
  )
}
