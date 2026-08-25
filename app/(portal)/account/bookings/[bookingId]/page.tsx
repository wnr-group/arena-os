import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { getPortalBooking } from '@/lib/portal/bookings'
import { portalTenant } from '@/lib/portal/tenant'
import { STATUS_LABELS, STATUS_STYLES, whenLabel } from '@/components/portal/BookingRow'
import { formatMoney, prettyDate, timeInZone } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { cn } from '@/lib/utils/cn'
import { CancelBookingButton } from '@/components/portal/CancelBookingButton'

/**
 * One booking, in detail (AROS-89) — read-only.
 *
 * ── Why the URL id is safe here ─────────────────────────────────────────────
 *
 * `bookingId` comes straight from the address bar, so it is treated purely as a
 * lookup key. It is NEVER the thing that decides access: getPortalBooking()
 * runs inside withCustomer(), where RLS has already reduced `bookings` to the
 * signed-in customer's own rows, so another customer's id matches nothing and
 * comes back null.
 *
 * Both "no such booking" and "not yours" therefore land on the SAME notFound().
 * That is deliberate — a distinct 403 would confirm to anyone walking UUIDs
 * that a particular booking exists and belongs to somebody else.
 */
export default async function PortalBookingDetailPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const { bookingId } = await params
  const [tenant, booking] = await Promise.all([portalTenant(), getPortalBooking(bookingId)])

  if (!booking) notFound()

  const { timezone: tz, currency } = tenant

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/account/bookings"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} />
          All bookings
        </Link>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{booking.bookingNumber}</h1>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              STATUS_STYLES[booking.status] ?? 'bg-muted text-muted-foreground',
            )}
          >
            {STATUS_LABELS[booking.status] ?? booking.status}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{whenLabel(booking, tz)}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {booking.canCancel && (
            <CancelBookingButton
              bookingId={booking.id}
              hasDeposit={booking.hasDeposit}
              cutoffHours={booking.policy.cutoffHours}
            />
          )}
          {/* Offered on every booking, not just past ones — "same thing again,
              different day" is a reasonable thing to want from a booking you
              already have. It only ever prefills; the new slot goes through the
              normal public availability flow. */}
          <Link
            href={`/account/bookings/${booking.id}/rebook`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
          >
            <RotateCcw size={14} aria-hidden />
            Book again
          </Link>
        </div>

        {booking.depositReviewRequired && (
          <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            You paid a deposit on this cancelled booking. It has been flagged for the venue to
            review — it is not refunded automatically.
          </p>
        )}
      </div>

      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">What you booked</h2>
        {booking.slots.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No resource was recorded for this booking.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {booking.slots.map((slot, i) => (
              <li key={i} className="px-4 py-3">
                <p className="text-sm font-medium">{slot.resourceName}</p>
                <p className="text-xs text-muted-foreground">
                  {slot.resourceTypeName} · {prettyDate(todayInZone(tz, slot.startsAt), tz)} ·{' '}
                  {timeInZone(slot.startsAt, tz)}–{timeInZone(slot.endsAt, tz)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Every figure is the STORED value from the booking. Nothing here is
          recalculated from today's rates — a past booking's price is history. */}
      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Payment</h2>
        <dl className="divide-y divide-border">
          <Row label="Subtotal" value={formatMoney(booking.subtotal, currency)} />
          {Number(booking.discount) > 0 && (
            <Row label="Discount" value={`−${formatMoney(booking.discount, currency)}`} />
          )}
          {Number(booking.tax) > 0 && <Row label="Tax" value={formatMoney(booking.tax, currency)} />}
          <Row label="Total" value={formatMoney(booking.total, currency)} strong />
          {Number(booking.deposit) > 0 && (
            <Row label="Deposit paid" value={formatMoney(booking.deposit, currency)} />
          )}
        </dl>
      </section>

      {booking.notes && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{booking.notes}</p>
        </section>
      )}

      {/* The existing public confirmation page (app/(public)/b/[token]) carries
          the check-in QR code. Linking to it reuses that rather than building a
          second one; the token is this customer's own, and is what the page is
          keyed on (0026). */}
      <p className="text-sm">
        <Link
          href={`/b/${booking.confirmationToken}`}
          className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Open confirmation &amp; check-in code
        </Link>
      </p>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  )
}
