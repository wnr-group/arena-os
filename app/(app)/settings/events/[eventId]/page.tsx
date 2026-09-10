import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, CalendarDays, MapPin, Trophy, Users } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getEvent } from '@/lib/events/data'
import { listEventEntrants } from '@/lib/events/registrations'
import { EVENT_STATUS_LABELS, EVENT_TYPE_LABELS, placesNoun, spotsRemaining } from '@/lib/events/types'
import { OCCUPYING_STATUSES } from '@/lib/events/registration'
import { formatEventWindow } from '@/lib/events/format'
import { formatMoney } from '@/lib/format'
import { getEventCheckInCounts } from '@/lib/events/check-in'
import { EventEntrantsTable } from '@/components/events/EventEntrantsTable'
import { EventCheckInPanel } from '@/components/events/EventCheckInPanel'

/**
 * The entrants for one event (M15 #3) — the venue's door list.
 *
 * Manager-gated the same three ways the events list is: this redirect, then
 * requireManager() inside cancelEventRegistration/checkInEventRegistration, then
 * event_registrations_manager_write in migration 0091. Reading is wider —
 * event_registrations_select admits any active member of the tenant — but the
 * page itself stays manager-only because it is reached from a manager screen
 * and shows amounts paid.
 *
 * The counts here go through the SAME occupancy rule the capacity guard uses
 * (OCCUPYING_STATUSES, mirrored by event_registration_occupancy()), so what a
 * manager reads is what the database will decide by.
 */
export default async function EventEntrantsPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const { eventId } = await params
  const event = await getEvent(ctx, eventId)
  // getEvent is tenant-scoped through RLS, so another tenant's id is simply
  // not found — the same answer an unknown id gives.
  if (!event) notFound()

  const entrants = await listEventEntrants(ctx, event.id)
  // Counted in SQL rather than from the rows above, so the headline numbers
  // come from the database rather than from whatever the list happened to load.
  const counts = await getEventCheckInCounts(ctx, event.id)

  const taken = entrants.filter((e) =>
    (OCCUPYING_STATUSES as readonly string[]).includes(e.status),
  ).length
  const waitlisted = entrants.filter((e) => e.status === 'waitlisted').length
  const left = spotsRemaining(event.capacity, taken)
  const noun = event.registrationMode === 'team' ? 'teams' : 'entrants'

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/settings/events"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft size={15} aria-hidden /> All events
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{event.title}</h1>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <dd className="flex items-center gap-1.5">
              <CalendarDays size={14} />{' '}
              {formatEventWindow(event.startsAt, event.endsAt, ctx.tenant.timezone)}
            </dd>
            <dd className="flex items-center gap-1.5">
              <MapPin size={14} /> {EVENT_TYPE_LABELS[event.type]}
            </dd>
            <dd className="flex items-center gap-1.5">
              <Users size={14} />{' '}
              {event.capacity === null
                ? `${taken} ${noun}, unlimited capacity`
                : `${taken} of ${event.capacity} ${noun} · ${left} ${placesNoun(event.registrationMode, left ?? 0)} left`}
            </dd>
            <dd>
              {Number(event.entryFee) === 0
                ? 'Free entry'
                : `${formatMoney(event.entryFee, ctx.tenant.currency)}${event.registrationMode === 'team' ? ' per team' : ''}`}
            </dd>
          </dl>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {EVENT_STATUS_LABELS[event.status]}
        </span>
      </div>

      {/* M15 #5 — the door. Live counts, QR scan and waitlist promotion.
          Every action inside is manager-guarded server-side. */}
      <EventCheckInPanel eventId={event.id} counts={counts} capacity={event.capacity} />

      {/* M15 #6 — the draw. Only tournaments have one; the link is offered
          whenever the event carries a format. */}
      {event.tournamentFormat && (
        <Link
          href={`/settings/events/${event.id}/bracket`}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
        >
          <Trophy size={15} aria-hidden /> Bracket &amp; scores
        </Link>
      )}

      {waitlisted > 0 && (
        <p className="mt-4 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          {waitlisted} on the waitlist. Cancelling a confirmed entry promotes the next one
          automatically, in the order they joined.
        </p>
      )}

      <EventEntrantsTable
        currency={ctx.tenant.currency}
        entrants={entrants.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }))}
      />
    </div>
  )
}
