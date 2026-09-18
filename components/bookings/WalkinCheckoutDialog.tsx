'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { checkoutWalkin, previewWalkinCheckout } from '@/lib/actions/bookings'
import { formatMoney, timeInZone } from '@/lib/format'

/** Mirrors lib/booking/walkin.ts's WALKIN_CHECKOUT_WINDOW_MINUTES (5-min steps within it). */
const OFFSET_STEP_MIN = 5
const OFFSET_MAX_MIN = 30

/**
 * "Close tab" — confirm an open-tab walk-in's end time, price it by elapsed
 * time, and raise the bill in one step (M21 #4). Bespoke dialog for the same
 * reason VoidCompDialog is: this needs a live-updating end-time control, not
 * a yes/no confirm.
 *
 * The shown amount comes from previewWalkinCheckout — the exact same
 * priceElapsedTime call checkoutWalkin itself makes — so as long as nothing
 * else touches this booking between the last preview and the confirm click,
 * what's on screen is what gets billed, to the paisa.
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
  const endAtIso = new Date(baseNow.getTime() + offsetMin * 60_000).toISOString()

  const [preview, setPreview] = useState<{ total: number; billableEnd: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    previewWalkinCheckout({ bookingId: booking.bookingId, endAt: endAtIso }).then((r) => {
      if (cancelled) return
      setPreviewLoading(false)
      if (r.error || r.total === undefined || r.billableEnd === undefined) {
        setPreviewError(r.error ?? 'Could not price this session.')
        setPreview(null)
        return
      }
      setPreview({ total: r.total, billableEnd: r.billableEnd })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.bookingId, offsetMin])

  function confirm() {
    setError(null)
    start(async () => {
      const r = await checkoutWalkin({ bookingId: booking.bookingId, endAt: endAtIso })
      if (r.error || !r.invoiceId) {
        setError(r.error ?? 'Could not close this tab.')
        return
      }
      toast.success(`Invoice ${r.invoiceNumber} raised for ${booking.bookingNumber}.`)
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

        <label className="mt-4 block text-sm font-medium text-foreground">End time</label>
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
            {timeInZone(endAtIso, timeZone)}
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
            disabled={pending || previewLoading || !preview}
            onClick={confirm}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Close tab &amp; raise bill
          </button>
        </div>
      </div>
    </div>
  )
}
