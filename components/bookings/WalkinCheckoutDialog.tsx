'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { checkoutWalkin, previewWalkinCheckout } from '@/lib/actions/bookings'
import { dateInZone, formatMoney, timeInZone } from '@/lib/format'
import { LATE_CHECKOUT_MAX_DAYS, resolveLateCheckoutEnd, toDatetimeLocal } from '@/lib/booking/walkin-end-time'

/** Mirrors lib/booking/walkin.ts's WALKIN_CHECKOUT_WINDOW_MINUTES (5-min steps within it). */
const OFFSET_STEP_MIN = 5
const OFFSET_MAX_MIN = 30

/**
 * "Close tab" — confirm an open-tab walk-in's end time and price it by
 * elapsed time (M21 #4). Bespoke dialog for the same reason VoidCompDialog
 * is: this needs a live-updating end-time control, not a yes/no confirm.
 *
 * The shown amount comes from previewWalkinCheckout — the exact same
 * priceElapsedTime call checkoutWalkin itself makes — so as long as nothing
 * else touches this booking between the last preview and the confirm click,
 * what's on screen is what gets frozen onto the slot.
 *
 * M22 follow-up: this no longer raises the invoice itself. Closing the tab
 * only prices/freezes the session; the caller then lands on the same POS
 * bill screen a reserved booking uses (/pos/[bookingId]), where staff review
 * the amount and can apply a discount/promo/loyalty before actually raising
 * the bill — see checkoutWalkin's own doc comment (lib/actions/bookings.ts)
 * for the full reasoning.
 */
export function WalkinCheckoutDialog({
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

  // Fixed at mount so the dialog's "now" doesn't visibly creep while it's
  // open — same idea as the walk-in start form's own offset control.
  const [baseNow] = useState(() => new Date())
  const [offsetMin, setOffsetMin] = useState(0)

  // M32 #2: "This was a while ago" — a forgotten tab closed at the time it
  // really ended, up to LATE_CHECKOUT_MAX_DAYS back. Off by default: the
  // ±30-min stepper above stays the everyday path, completely unchanged. The
  // picker value is the BRANCH's wall time (see resolveLateCheckoutEnd);
  // client validation is a convenience, checkoutWalkinCore is the guard.
  const [late, setLate] = useState(false)
  const [lateValue, setLateValue] = useState(() => toDatetimeLocal(baseNow, timeZone))
  const lateMin = toDatetimeLocal(new Date(baseNow.getTime() - LATE_CHECKOUT_MAX_DAYS * 24 * 60 * 60_000), timeZone)
  const lateMax = toDatetimeLocal(baseNow, timeZone)
  const lateResult = late ? resolveLateCheckoutEnd(lateValue, timeZone, baseNow, booking.startsAt) : null
  const lateError = lateResult && 'error' in lateResult ? lateResult.error : null

  // The one endAt both the live preview and the confirm use. null = the late
  // picker holds something unusable right now (nothing is priced or sent).
  const stepperIso = new Date(baseNow.getTime() + offsetMin * 60_000).toISOString()
  const endAtIso: string | null = lateResult ? ('iso' in lateResult ? lateResult.iso : null) : stepperIso

  const isPerHead = booking.pricingMode === 'per_head'
  const isBoard = !isPerHead && booking.extraPlayerRateApplied != null
  const takesPlayers = isPerHead || isBoard
  // M21 per-head #4: an in-progress edit — travels with the preview, only
  // ever WRITTEN by checkoutWalkin itself at confirm, same discipline
  // offsetMin/endAt already has.
  const [headCount, setHeadCount] = useState(
    booking.headCount ?? (isBoard ? (booking.includedPlayers ?? 1) : (booking.minPlayers ?? 1)),
  )
  // A surcharge board has no real floor: fewer players than included just
  // means no surcharge.
  const minPlayers = isBoard ? 1 : (booking.minPlayers ?? 1)

  const [preview, setPreview] = useState<{ total: number; addonTotal: number; billableEnd: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    let cancelled = false
    if (endAtIso === null) {
      // An unusable late-picker value: show its own message, price nothing.
      setPreview(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    setPreviewError(null)
    previewWalkinCheckout({
      bookingId: booking.bookingId,
      endAt: endAtIso,
      headCount: takesPlayers ? headCount : undefined,
    }).then((r) => {
      if (cancelled) return
      setPreviewLoading(false)
      if (r.error || r.total === undefined || r.billableEnd === undefined) {
        setPreviewError(r.error ?? 'Could not price this session.')
        setPreview(null)
        return
      }
      setPreview({ total: r.total, addonTotal: r.addonTotal ?? 0, billableEnd: r.billableEnd })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.bookingId, endAtIso, headCount])

  function confirm() {
    if (endAtIso === null) return
    setError(null)
    start(async () => {
      const r = await checkoutWalkin({
        bookingId: booking.bookingId,
        endAt: endAtIso,
        headCount: takesPlayers ? headCount : undefined,
      })
      if (r.error || !r.bookingId) {
        setError(r.error ?? 'Could not close this tab.')
        return
      }
      toast.success(`Tab closed for ${booking.bookingNumber} — review the bill.`)
      router.push(`/pos/${booking.bookingId}`)
    })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={pending ? undefined : onClose}
      role="alertdialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Close tab — {booking.resourceName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {booking.customerName || booking.customerPhone || 'Walk-in'} · started {timeInZone(booking.startsAt, timeZone)}
        </p>

        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor={late ? 'walkin-late-end' : undefined}>
          End time
        </label>
        {late ? (
          <div className="mt-2">
            <input
              id="walkin-late-end"
              type="datetime-local"
              value={lateValue}
              min={lateMin}
              max={lateMax}
              onChange={(e) => setLateValue(e.target.value)}
              disabled={pending}
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
            />
            {endAtIso ? (
              <p className="mt-1.5 text-sm font-medium text-foreground">
                Closing at {dateInZone(endAtIso, timeZone)}, {timeInZone(endAtIso, timeZone)}
              </p>
            ) : null}
            {lateError && (
              <p role="alert" className="mt-1.5 text-sm text-destructive">
                {lateError}
              </p>
            )}
            <p className="mt-1.5 text-xs text-muted-foreground">
              Enter when the session really ended — up to {LATE_CHECKOUT_MAX_DAYS} days back. This is recorded as a late
              checkout.
            </p>
            <button
              type="button"
              onClick={() => {
                setLate(false)
                setLateValue(toDatetimeLocal(baseNow, timeZone))
              }}
              disabled={pending}
              className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
            >
              ← Back to quick adjust
            </button>
          </div>
        ) : (
        <>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOffsetMin((m) => Math.max(-OFFSET_MAX_MIN, m - OFFSET_STEP_MIN))}
            disabled={pending || offsetMin <= -OFFSET_MAX_MIN}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
          >
            − {OFFSET_STEP_MIN} min
          </button>
          <span className="flex-1 rounded-lg border border-border bg-accent/40 px-3 py-2 text-center text-base font-semibold text-foreground">
            {timeInZone(stepperIso, timeZone)}
            {offsetMin !== 0 && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ({offsetMin > 0 ? `+${offsetMin}` : offsetMin} min)
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setOffsetMin((m) => Math.min(OFFSET_MAX_MIN, m + OFFSET_STEP_MIN))}
            disabled={pending || offsetMin >= OFFSET_MAX_MIN}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
          >
            + {OFFSET_STEP_MIN} min
          </button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Up to {OFFSET_MAX_MIN} minutes either side of now.</p>
        <button
          type="button"
          onClick={() => setLate(true)}
          disabled={pending}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
        >
          <CalendarClock size={12} aria-hidden /> This was a while ago
        </button>
        </>
        )}

        {takesPlayers && (
          <>
            <label className="mt-4 block text-sm font-medium text-foreground">Players</label>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setHeadCount((h) => Math.max(minPlayers, h - 1))}
                disabled={pending || headCount <= minPlayers}
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
                disabled={pending}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {isBoard
                ? `Editing re-prices the whole session — ${booking.includedPlayers ?? 1} included, extra players are charged.`
                : `Editing re-prices the whole session — minimum ${minPlayers}.`}
            </p>
          </>
        )}

        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Elapsed-time charge</span>
            {previewLoading && <Loader2 size={14} className="animate-spin" />}
          </div>
          {previewError ? (
            <p className="mt-1 text-sm text-destructive">{previewError}</p>
          ) : (
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
              {preview ? formatMoney(preview.total, currency) : '—'}
            </p>
          )}
          {preview && preview.addonTotal > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              Includes {formatMoney(preview.addonTotal, currency)} of rented add-ons.
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            30-min minimum, rounded up to the nearest 15 minutes. Food/orders fold into the same bill.
          </p>
        </div>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending || previewLoading || !preview || endAtIso === null}
            onClick={confirm}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Close tab
          </button>
        </div>
      </div>
    </div>
  )
}
