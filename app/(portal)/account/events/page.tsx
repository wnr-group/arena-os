import Link from 'next/link'
import { CalendarDays, MapPin, Users } from 'lucide-react'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { currentTenantSlug } from '@/lib/tenant/context'
import { listMyEventRegistrations } from '@/lib/events/registrations'
import { EVENT_TYPE_LABELS } from '@/lib/events/types'
import { EVENT_REGISTRATION_STATUS_LABELS, type EventRegistrationStatus } from '@/lib/events/registration'
import { formatEventWindow } from '@/lib/events/format'
import { formatMoney } from '@/lib/format'
import { MyEventRegistrationRow } from '@/components/portal/MyEventRegistrationRow'

/**
 * The customer's own event entries (M15 #3).
 *
 * Reads through listMyEventRegistrations(), which runs under withCustomer — so
 * `event_registrations_customer_select` is what confines the list to this
 * customer's rows, not a WHERE clause this page could get wrong. The customer
 * id comes from requireCustomer(), i.e. from the validated OTP session, and is
 * never read from the URL.
 *
 * Team players who have no entry of their own (their captain holds it) do not
 * appear here; their team's entry is shown on the event's own registration page
 * through my_event_participation(). Listing somebody else's registration row in
 * a page that also shows amounts paid is exactly the leak that policy avoids.
 */

const STATUS_CLASS: Record<EventRegistrationStatus, string> = {
  registered: 'bg-emerald-500/10 text-emerald-700',
  checked_in: 'bg-emerald-500/10 text-emerald-700',
  pending_payment: 'bg-sky-500/10 text-sky-700',
  waitlisted: 'bg-amber-500/10 text-amber-700',
  cancelled: 'bg-muted text-muted-foreground',
}

export default async function MyEventsPage() {
  const customer = await requireCustomer('/account/events')
  const slug = await currentTenantSlug()
  const tenant = slug ? await getPublicTenantBySlug(slug) : null

  const registrations = await listMyEventRegistrations(customer.id)
  const timezone = tenant?.timezone ?? 'Asia/Kolkata'
  const currency = tenant?.currency ?? 'INR'

  return (
    <div>
      <h1 className="text-xl font-semibold">My events</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Tournaments, classes and everything else you have entered.
      </p>

      {registrations.length === 0 ? (
        <div className="mt-8 rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">You have not registered for any events yet.</p>
          <Link
            href="/events"
            className="mt-3 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Browse events
          </Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {registrations.map((r) => (
            <li key={r.registrationId} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/events/${r.eventId}`}
                    className="text-base font-semibold transition hover:text-primary"
                  >
                    {r.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">{EVENT_TYPE_LABELS[r.type]}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASS[r.status]}`}
                >
                  {EVENT_REGISTRATION_STATUS_LABELS[r.status]}
                </span>
              </div>

              <dl className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                <div className="flex items-start gap-2">
                  <dt className="sr-only">When</dt>
                  <CalendarDays size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <dd>{formatEventWindow(r.startsAt, r.endsAt, timezone)}</dd>
                </div>
                {r.branchName && (
                  <div className="flex items-start gap-2">
                    <dt className="sr-only">Venue</dt>
                    <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <dd>{r.branchName}</dd>
                  </div>
                )}
                {r.teamName && (
                  <div className="flex items-start gap-2">
                    <dt className="sr-only">Team</dt>
                    <Users size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <dd>{r.teamName}</dd>
                  </div>
                )}
              </dl>

              <p className="mt-3 text-sm">
                {Number(r.paidAmount) > 0 ? (
                  <span className="font-medium">Paid {formatMoney(r.paidAmount, currency)}</span>
                ) : Number(r.entryFee) > 0 ? (
                  <span className="text-muted-foreground">
                    Entry fee {formatMoney(r.entryFee, currency)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Free entry</span>
                )}
              </p>

              {r.refundRequired && (
                <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                  We received your payment but could not hold your place. The venue will be in touch
                  about a refund.
                </p>
              )}

              <MyEventRegistrationRow
                registrationId={r.registrationId}
                eventId={r.eventId}
                status={r.status}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
