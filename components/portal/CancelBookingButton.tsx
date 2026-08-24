'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { cancelMyBooking } from '@/lib/actions/customer-bookings'
import { cn } from '@/lib/utils/cn'

/**
 * Cancel control + confirmation dialog (AROS-90).
 *
 * The dialog is not decoration: cancelling frees a slot somebody else can
 * immediately take, and it is irreversible from the customer's side. It states
 * the venue's actual cutoff, and — when the venue is holding a deposit — says
 * plainly that the money goes to the venue for review rather than back to the
 * card, so nobody clicks through expecting an automatic refund.
 *
 * Nothing here decides eligibility. `canCancel` only governs whether the button
 * renders; the action re-checks ownership, status, the cutoff and open orders
 * server-side, and the database permits exactly one transition regardless (see
 * bookings_customer_cancel in migration 0047).
 */
export function CancelBookingButton({
  bookingId,
  hasDeposit,
  cutoffHours,
  className,
}: {
  bookingId: string
  hasDeposit: boolean
  cutoffHours: number
  className?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function confirm() {
    setError(null)
    startTransition(async () => {
      const result = await cancelMyBooking({ bookingId })
      if (result.error) {
        setError(result.error)
        return
      }
      setOpen(false)
      // The action already revalidated the portal paths; refresh() is what makes
      // this router instance re-render them, so the booking visibly moves from
      // Upcoming to Past without a manual reload.
      router.refresh()
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
        className={cn(
          'rounded-md border border-border px-3 py-1.5 text-sm font-medium transition',
          'hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive',
          className,
        )}
      >
        Cancel booking
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-booking-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg">
            <h2 id="cancel-booking-title" className="text-base font-semibold">
              Cancel this booking?
            </h2>

            <p className="mt-2 text-sm text-muted-foreground">
              Your slot will be released straight away and someone else may book it. This cannot be
              undone.
            </p>

            <p className="mt-2 text-sm text-muted-foreground">
              {cutoffHours > 0
                ? `This venue allows online cancellation up to ${cutoffHours} ${
                    cutoffHours === 1 ? 'hour' : 'hours'
                  } before the start time.`
                : 'This venue allows online cancellation any time before the booking starts.'}
            </p>

            {hasDeposit && (
              <p className="mt-3 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  You paid a deposit on this booking. It is <strong>not refunded automatically</strong>
                  {' '}— the venue will review it and be in touch.
                </span>
              </p>
            )}

            {error && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                Keep booking
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 size={14} className="animate-spin" aria-hidden />}
                {pending ? 'Cancelling…' : 'Yes, cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
