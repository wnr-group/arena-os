import Link from 'next/link'
import { CalendarDays, MapPin, Trophy, Users } from 'lucide-react'
import type { PublicEvent } from '@/lib/events/public'
import {
  EVENT_TYPE_LABELS,
  TOURNAMENT_FORMAT_LABELS,
  acceptsRegistrations,
  placesNoun,
} from '@/lib/events/types'
import { formatMoney } from '@/lib/format'
import { formatEventWindow } from '@/lib/events/format'

/**
 * One event, as a card. Shared by the /events listing, the website builder's
 * "Upcoming Events" homepage section and the default TenantHome strip, so all
 * three show exactly one card design — the same reason ResourceTypeCard is
 * shared between /resources and the featured-resources section.
 *
 * Server component: no state, no handlers, so it costs the client bundle
 * nothing and the tenant's timezone formatting happens once on the server.
 */
export function EventCard({
  event,
  currency,
  timezone,
}: {
  event: PublicEvent
  currency: string
  timezone: string
}) {
  const free = Number(event.entryFee) === 0
  const open = acceptsRegistrations(event.status)

  return (
    <Link
      href={`/events/${event.id}`}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
    >
      <div className="relative aspect-[16/9] w-full shrink-0 overflow-hidden bg-primary/5">
        {event.bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.bannerUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-primary/30">
            <CalendarDays size={32} />
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-full bg-background/90 px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur">
          {EVENT_TYPE_LABELS[event.type]}
        </span>
        {open && (
          <span className="absolute right-3 top-3 rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm">
            Registration open
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h3 className="line-clamp-2 text-lg font-bold text-foreground transition group-hover:text-primary">
          {event.title}
        </h3>

        <dl className="mt-3 space-y-1.5 text-sm text-muted-foreground">
          <div className="flex items-start gap-2">
            <dt className="sr-only">When</dt>
            <CalendarDays size={15} className="mt-0.5 shrink-0" aria-hidden />
            <dd>{formatEventWindow(event.startsAt, event.endsAt, timezone)}</dd>
          </div>
          {event.branchName && (
            <div className="flex items-start gap-2">
              <dt className="sr-only">Venue</dt>
              <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden />
              <dd>{event.branchName}</dd>
            </div>
          )}
          {event.tournamentFormat && (
            <div className="flex items-start gap-2">
              <dt className="sr-only">Format</dt>
              <Trophy size={15} className="mt-0.5 shrink-0" aria-hidden />
              <dd>{TOURNAMENT_FORMAT_LABELS[event.tournamentFormat]}</dd>
            </div>
          )}
          <div className="flex items-start gap-2">
            <dt className="sr-only">Places</dt>
            <Users size={15} className="mt-0.5 shrink-0" aria-hidden />
            <dd>
              {event.spotsLeft === null
                ? `Unlimited ${placesNoun(event.registrationMode, 2)}`
                : `${event.spotsLeft} of ${event.capacity} ${placesNoun(event.registrationMode, event.spotsLeft)} left`}
            </dd>
          </div>
        </dl>

        <p className="mt-4 pt-3 text-base font-bold text-foreground">
          {free ? 'Free entry' : formatMoney(event.entryFee, currency)}
        </p>
      </div>
    </Link>
  )
}
