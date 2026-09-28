'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { cancelBooking } from '@/lib/actions/bookings'

/**
 * Cancel a booking, with a required reason — bespoke rather than ConfirmDialog
 * for the same reason VoidCompDialog is: this needs free text. Shared by
 * BookingsView and FloorView, the two staff screens that can cancel a booking;
 * setBookingStatus (lib/actions/bookings.ts) refuses a 'cancelled' write with
 * no reason regardless of which one calls it.
 */
export function CancelBookingDialog({
  bookingId,
  title,
  description,
  confirmText = 'Cancel booking',
  onClose,
  onDone,
}: {
  bookingId: string
  title: string
  description: string
  confirmText?: string
  onClose: () => void
  onDone: () => void
}) {
  useBodyScrollLock()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit() {
    const trimmed = reason.trim()
    if (!trimmed) {
      setError('Enter a reason for cancelling.')
      return
    }
    setError(null)
    startTransition(async () => {
      const r = await cancelBooking(bookingId, trimmed)
      if (r.error) setError(r.error)
      else onDone()
    })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={pending ? undefined : onClose}
      role="alertdialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>

        <label className="mt-3 block text-sm font-medium">
          Reason for cancelling
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer no longer needs it, double-booked, venue closed early..."
            rows={3}
            autoFocus
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal outline-none focus:border-primary disabled:opacity-60"
          />
        </label>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Keep booking
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-destructive px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={handleSubmit}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
