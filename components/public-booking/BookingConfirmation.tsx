import Link from 'next/link'
import { CalendarDays, Clock, Boxes, Sparkles, User, CheckCircle2, XCircle, UserX, type LucideIcon } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { PublicBookingConfirmation } from '@/lib/booking/public-confirmation'
import type { PublicTenant } from '@/lib/tenant/public'

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Booking confirmed',
  checked_in: "You're checked in!",
  completed: 'Visit completed',
  cancelled: 'Booking cancelled',
  no_show: 'Marked as no-show',
}

const STATUS_ICON: Record<string, LucideIcon> = {
  confirmed: CheckCircle2,
  checked_in: CheckCircle2,
  completed: CheckCircle2,
  cancelled: XCircle,
  no_show: UserX,
}

function fmtDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

function fmtTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(
    new Date(iso),
  )
}

/**
 * The public confirmation page's content — booking details plus the
 * check-in QR, rendered inside the site's standard PublicNavbar/PublicFooter
 * shell (added by the page). `qrSvg` is pre-rendered server-side
 * (lib/utils/qr.ts) and trusted markup, not user input.
 */
export function BookingConfirmation({
  booking,
  tenant,
  qrSvg,
}: {
  booking: PublicBookingConfirmation
  tenant: PublicTenant
  qrSvg: string
}) {
  const slot = booking.slots[0] ?? null
  const StatusIcon = STATUS_ICON[booking.status] ?? CheckCircle2
  const statusLabel = STATUS_LABEL[booking.status] ?? booking.status
  const showQr = booking.status === 'confirmed' || booking.status === 'checked_in'

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <div className="text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-gradient-to-tr from-primary to-primary-hover text-primary-foreground shadow-lg shadow-primary/25">
          <StatusIcon size={30} />
        </div>
        <h1 className="mt-5 text-xl font-bold tracking-tight text-foreground">{statusLabel}</h1>
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground">
          Booking #{booking.bookingNumber}
        </p>
      </div>

      {showQr && (
        <div className="mt-8 flex flex-col items-center rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div
            className="size-48 [&_svg]:h-full [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <p className="mt-4 text-center text-sm text-muted-foreground">Show this code at the door to check in</p>
        </div>
      )}

      <div className="mt-6 space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
        {slot && <SummaryRow icon={Boxes} label="Resource" value={slot.resourceName} />}
        {slot && <SummaryRow icon={CalendarDays} label="Date" value={fmtDate(slot.startsAt, tenant.timezone)} />}
        {slot && (
          <SummaryRow
            icon={Clock}
            label="Time"
            value={`${fmtTime(slot.startsAt, tenant.timezone)} – ${fmtTime(slot.endsAt, tenant.timezone)}`}
          />
        )}
        {booking.customerName && <SummaryRow icon={User} label="Name" value={booking.customerName} />}
        <SummaryRow icon={Sparkles} label="Total" value={formatMoney(booking.total, tenant.currency)} />
      </div>

      <div className="mt-8 text-center">
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:-translate-y-0.5 hover:bg-primary-hover hover:shadow-lg active:translate-y-0"
        >
          Back to venue
        </Link>
      </div>
    </div>
  )
}

function SummaryRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon size={14} className="text-primary" /> {label}
      </span>
      <span className="truncate font-semibold text-foreground">{value}</span>
    </div>
  )
}
