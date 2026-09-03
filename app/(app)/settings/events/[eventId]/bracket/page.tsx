import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, CalendarDays, Trophy } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getEvent } from '@/lib/events/data'
import { getEventBracket } from '@/lib/events/bracket-service'
import { getEventCheckInCounts } from '@/lib/events/check-in'
import { EVENT_STATUS_LABELS, TOURNAMENT_FORMAT_LABELS } from '@/lib/events/types'
import { formatEventWindow } from '@/lib/events/format'
import { EventBracketBoard } from '@/components/events/EventBracketBoard'

/**
 * The staff bracket board for one event (M15 #6).
 *
 * Manager-gated three ways, the same as the entrants page it sits beside: this
 * redirect keeps it off a cashier's screen, requireManager() inside every
 * action in lib/actions/event-matches.ts rejects their mutations, and
 * event_matches_manager_write (0088) refuses the write at the database even if
 * both were bypassed. Reading is wider — event_matches_select admits any active
 * member — but the page stays manager-only because it is a management surface.
 *
 * Public bracket viewing is deliberately NOT here. It is not in this ticket,
 * and when it lands it gets its own reader and its own policy rather than
 * loosening this one.
 */
export default async function EventBracketPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const { eventId } = await params
  const event = await getEvent(ctx, eventId)
  // Tenant-scoped through RLS, so another tenant's id is simply not found —
  // the same answer an unknown id gives.
  if (!event) notFound()

  const [bracket, counts] = await Promise.all([
    getEventBracket(ctx, event.id),
    getEventCheckInCounts(ctx, event.id),
  ])

  const names = Object.fromEntries(bracket.participants.map((p) => [p.registrationId, p.name]))

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/settings/events/${event.id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft size={15} aria-hidden /> Entrants
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{event.title}</h1>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <dd className="flex items-center gap-1.5">
              <CalendarDays size={14} aria-hidden />{' '}
              {formatEventWindow(event.startsAt, event.endsAt, ctx.tenant.timezone)}
            </dd>
            <dd className="flex items-center gap-1.5">
              <Trophy size={14} aria-hidden />{' '}
              {event.tournamentFormat
                ? TOURNAMENT_FORMAT_LABELS[event.tournamentFormat]
                : 'No format'}
            </dd>
            <dd>
              {counts.checkedIn} checked in of {counts.confirmed} confirmed
            </dd>
          </dl>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {EVENT_STATUS_LABELS[event.status]}
        </span>
      </div>

      <EventBracketBoard
        eventId={event.id}
        format={bracket.format}
        matches={bracket.matches}
        standings={bracket.standings}
        participantNames={names}
        checkedInCount={counts.checkedIn}
      />
    </div>
  )
}
