import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CalendarDays, MapPin, Trophy, Users } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug, type PublicTenant } from '@/lib/tenant/public'
import { publicTenantUrl } from '@/lib/tenant/subdomain'
import { getPublicEventLive, type PublicLiveView } from '@/lib/events/public-live'
import { EVENT_STATUS_LABELS, EVENT_TYPE_LABELS, TOURNAMENT_FORMAT_LABELS } from '@/lib/events/types'
import { formatEventWindow } from '@/lib/events/format'
import { LiveBracket } from '@/components/public-booking/LiveBracket'

/**
 * THE PUBLIC LIVE BRACKET (M15 #7).
 *
 * Read-only, no session, reachable by anyone with the link.
 *
 * ── There is no mutation path from this page ────────────────────────────────
 *
 * It renders a server DTO and nothing more. It imports no server action, so
 * there is nothing for a spectator to POST to; the only public policies on
 * `events` and `event_matches` are SELECT (0099); and every write action in
 * lib/actions/event-matches.ts begins with requireManager(). Three independent
 * layers, none of which is "the button is hidden".
 *
 * ── Visibility ──────────────────────────────────────────────────────────────
 *
 * The tenant comes from the SUBDOMAIN, never from the URL or a query parameter,
 * so tenant A's host cannot serve tenant B's event however the id is spelt.
 * getPublicEventLive() returns null for a draft, a cancelled event, another
 * tenant's event and an unknown id alike, and this 404s on null — a visitor
 * cannot tell a hidden event from one that never existed.
 *
 * ── TV mode ─────────────────────────────────────────────────────────────────
 *
 * `?display=tv` — the same page, the same data, the same reader. Not a second
 * app and not a second route: a venue points a screen at the URL it already
 * has, with one parameter appended.
 */

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ eventId: string }>; searchParams: Promise<{ display?: string }> }

/** Tenant + live view, resolved the one way. Shared by the page and its metadata. */
async function resolve(
  eventId: string,
): Promise<{ tenant: PublicTenant; live: PublicLiveView } | null> {
  const slug = await currentTenantSlug()
  if (!slug) return null
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) return null
  const live = await getPublicEventLive(tenant.id, eventId)
  if (!live) return null
  return { tenant, live }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { eventId } = await params
  const resolved = await resolve(eventId)
  // Not public, or not ours: no title, no description, no image — the same
  // information a 404 gives. Metadata must not become a side channel for the
  // existence of a private event.
  if (!resolved) return { title: 'Event not found' }

  const { tenant, live } = resolved
  const { event } = live
  const url = publicTenantUrl(tenant.slug, `/events/${event.id}/live`)
  const title = `${event.title} — live — ${tenant.name}`
  const description =
    event.description?.trim().slice(0, 200) ||
    `Live bracket and results for ${event.title} at ${tenant.name}.`

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      title,
      description,
      url,
      siteName: tenant.name,
      // Only the event's own banner, which the venue chose to publish. No
      // participant or result data is rendered into an image.
      ...(event.bannerUrl ? { images: [{ url: event.bannerUrl }] } : {}),
    },
    twitter: {
      card: event.bannerUrl ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(event.bannerUrl ? { images: [event.bannerUrl] } : {}),
    },
  }
}

export default async function PublicLiveEventPage({ params, searchParams }: Params) {
  const { eventId } = await params
  const { display } = await searchParams
  const resolved = await resolve(eventId)
  if (!resolved) notFound()

  const { tenant, live } = resolved
  const { event } = live
  const tv = display === 'tv'

  return (
    <main
      className={
        tv
          ? 'min-h-screen w-full bg-background px-8 py-8'
          : 'mx-auto max-w-5xl px-4 py-8 sm:px-6'
      }
    >
      {!tv && (
        <Link
          href={`/events/${event.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft size={15} aria-hidden /> Event details
        </Link>
      )}

      <header className={tv ? 'border-b border-border pb-6' : 'mt-4'}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className={`font-bold ${tv ? 'text-6xl' : 'text-2xl sm:text-3xl'}`}>
              {event.title}
            </h1>
            <dl
              className={`mt-2 flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground ${
                tv ? 'text-2xl' : 'text-sm'
              }`}
            >
              <dd className="flex items-center gap-1.5">
                <CalendarDays size={tv ? 22 : 14} aria-hidden />{' '}
                {/* The TENANT's timezone, not the viewer's — a venue screen must
                    show the venue's clock. */}
                {formatEventWindow(event.startsAt, event.endsAt, tenant.timezone)}
              </dd>
              {event.branchName && (
                <dd className="flex items-center gap-1.5">
                  <MapPin size={tv ? 22 : 14} aria-hidden /> {event.branchName}
                </dd>
              )}
              <dd className="flex items-center gap-1.5">
                <Trophy size={tv ? 22 : 14} aria-hidden />{' '}
                {event.format ? TOURNAMENT_FORMAT_LABELS[event.format] : EVENT_TYPE_LABELS[event.type]}
              </dd>
              {event.participantCount > 0 && (
                <dd className="flex items-center gap-1.5">
                  <Users size={tv ? 22 : 14} aria-hidden /> {event.participantCount} competing
                </dd>
              )}
            </dl>
          </div>

          <span
            className={`shrink-0 rounded-full px-3 py-1 font-medium ${
              tv ? 'text-2xl' : 'text-xs'
            } ${
              event.status === 'in_progress'
                ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {EVENT_STATUS_LABELS[event.status]}
          </span>
        </div>

        {live.champion && (
          <p
            className={`mt-4 rounded-xl bg-primary/10 px-4 py-3 font-semibold text-primary ${
              tv ? 'text-4xl' : 'text-base'
            }`}
          >
            🏆 {live.champion} wins {event.title}
          </p>
        )}
      </header>

      <div className={tv ? 'mt-8' : 'mt-6'}>
        <LiveBracket
          format={event.format}
          matches={live.matches}
          standings={live.standings}
          isComplete={live.isComplete}
          tv={tv}
        />
      </div>

      {!tv && (
        <p className="mt-8 text-center text-xs text-muted-foreground">
          <Link href={`/events/${event.id}/live?display=tv`} className="underline">
            Open venue screen view
          </Link>
        </p>
      )}
    </main>
  )
}
