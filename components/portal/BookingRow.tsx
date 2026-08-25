import Link from 'next/link'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { formatMoney, prettyDate, timeInZone } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { cn } from '@/lib/utils/cn'
import type { PortalBookingSummary } from '@/lib/portal/bookings'
import { CancelBookingButton } from './CancelBookingButton'

/**
 * One booking in the portal's list (AROS-89).
 *
 * A server component — there is nothing interactive here beyond a link, so
 * none of this needs to reach the browser as JavaScript.
 *
 * The status labels below duplicate the map inside
 * components/bookings/BookingsView.tsx rather than importing it. That file is a
 * large 'use client' staff view; importing a constant out of it would drag the
 * whole staff booking board into the customer bundle, and would couple two
 * audiences that must be free to word things differently ("No-show" is a note
 * to staff, not something to say to a customer).
 */

const STATUS_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Missed',
}

const STATUS_STYLES: Record<string, string> = {
  confirmed: 'bg-emerald-500/10 text-emerald-600',
  checked_in: 'bg-sky-500/10 text-sky-600',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  no_show: 'bg-amber-500/10 text-amber-600',
}

/**
 * Render the booking's window in the VENUE's timezone, never the browser's.
 *
 * todayInZone() turns the instant into the calendar date as seen at the venue,
 * which prettyDate() then formats — the same two helpers the staff booking board
 * uses, so a customer and the front desk always read the same date for the same
 * booking even when the customer is in another zone.
 *
 * An overnight slot (22:00 → 02:00) genuinely spans two dates, so both are
 * shown rather than silently dropping the second.
 */
function whenLabel(booking: PortalBookingSummary, timeZone: string): string {
  if (!booking.startsAt || !booking.endsAt) return '—'

  const startDate = todayInZone(timeZone, booking.startsAt)
  const endDate = todayInZone(timeZone, booking.endsAt)
  const start = timeInZone(booking.startsAt, timeZone)
  const end = timeInZone(booking.endsAt, timeZone)

  if (startDate === endDate) {
    return `${prettyDate(startDate, timeZone)} · ${start}–${end}`
  }
  return `${prettyDate(startDate, timeZone)} ${start} → ${prettyDate(endDate, timeZone)} ${end}`
}

export function BookingRow({
  booking,
  timeZone,
  currency,
  cutoffHours,
  showRebook,
}: {
  booking: PortalBookingSummary
  timeZone: string
  currency: string
  cutoffHours: number
  /** Past sections offer "Book again"; upcoming ones offer Cancel. */
  showRebook?: boolean
}) {
  const resources =
    booking.resourceNames.length > 0 ? booking.resourceNames.join(', ') : 'No resource recorded'

  return (
    <li className="px-4 py-3">
      {/* The row's link and its action buttons are siblings, not nested: a
          <button> inside an <a> is invalid HTML and swallows the click. */}
      <div className="flex items-center gap-3">
        <Link
          href={`/account/bookings/${booking.id}`}
          className="-m-1 min-w-0 flex-1 rounded p-1 transition hover:bg-muted/50"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-medium">{resources}</p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                STATUS_STYLES[booking.status] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {STATUS_LABELS[booking.status] ?? booking.status}
            </span>
            {booking.depositReviewRequired && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                Deposit with venue
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{whenLabel(booking, timeZone)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{booking.bookingNumber}</p>
        </Link>

        <span className="shrink-0 text-sm tabular-nums">
          {formatMoney(booking.total, currency)}
        </span>
        <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      </div>

      {(booking.canCancel || showRebook) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {booking.canCancel && (
            <CancelBookingButton
              bookingId={booking.id}
              hasDeposit={booking.hasDeposit}
              cutoffHours={cutoffHours}
            />
          )}
          {showRebook && (
            <Link
              href={`/account/bookings/${booking.id}/rebook`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
            >
              <RotateCcw size={14} aria-hidden />
              Book again
            </Link>
          )}
        </div>
      )}
    </li>
  )
}

/** A titled card holding one section's rows, or its own empty message. */
export function BookingSection({
  title,
  emptyMessage,
  bookings,
  timeZone,
  currency,
  cutoffHours,
  showRebook,
}: {
  title: string
  emptyMessage: string
  bookings: PortalBookingSummary[]
  timeZone: string
  currency: string
  cutoffHours: number
  showRebook?: boolean
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <h2 className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold">
        {title}
        {bookings.length > 0 && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {bookings.length}
          </span>
        )}
      </h2>

      {bookings.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-border">
          {bookings.map((booking) => (
            <BookingRow
              key={booking.id}
              booking={booking}
              timeZone={timeZone}
              currency={currency}
              cutoffHours={cutoffHours}
              showRebook={showRebook}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export { STATUS_LABELS, STATUS_STYLES, whenLabel }
