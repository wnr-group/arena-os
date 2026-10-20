import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Building2, CalendarDays, Clock, MapPin, Trophy, Users } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug, type PublicTenant } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { getPublicEventById, type PublicEvent } from '@/lib/events/public'
import {
  EVENT_TYPE_LABELS,
  TOURNAMENT_FORMAT_LABELS,
  acceptsRegistrations,
  placesNoun,
} from '@/lib/events/types'
import { publicEventHasBracket } from '@/lib/events/public-live'
import { formatEventDate, formatEventTime } from '@/lib/events/format'
import { formatMoney } from '@/lib/format'
import { publicTenantUrl } from '@/lib/tenant/subdomain'
import { INDUSTRY_ICONS, INDUSTRY_LABELS } from '@/components/public-booking/TenantHome'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'

/**
 * The public event detail page (M15 #2).
 *
 * ── Why every non-public case 404s identically ──────────────────────────────
 *
 * getPublicEventById() returns null for an unknown id, another tenant's event,
 * a draft, a cancelled event — all of it. This page then calls notFound() with
 * no branching, so a visitor cannot distinguish "no such event" from "an event
 * exists but you may not see it". Distinguishing them would leak the existence
 * of a private event, which is exactly what a probing script wants to learn.
 *
 * generateMetadata() resolves through the SAME reader, so a non-public event
 * cannot leak its title through an OG tag either — the metadata for a hidden
 * event is the bare fallback, identical to a 404.
 */

/** Tenant + event, resolved the one way. Shared by the page and its metadata. */
async function resolve(eventId: string): Promise<{ tenant: PublicTenant; event: PublicEvent } | null> {
  const slug = await currentTenantSlug()
  if (!slug) return null
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) return null
  const event = await getPublicEventById(tenant.id, eventId)
  if (!event) return null
  return { tenant, event }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventId: string }>
}): Promise<Metadata> {
  const { eventId } = await params
  const resolved = await resolve(eventId)
  // Not public (or not ours): no title, no description, no image. Same
  // information a 404 gives.
  if (!resolved) return { title: 'Event not found' }

  const { tenant, event } = resolved
  const when = formatEventDate(event.startsAt, tenant.timezone)
  const title = `${event.title} — ${tenant.name}`
  const description =
    event.description?.trim().slice(0, 200) ??
    `${EVENT_TYPE_LABELS[event.type]} at ${tenant.name} on ${when}.`
  const url = publicTenantUrl(tenant.slug, `/events/${event.id}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: tenant.name,
      type: 'website',
      // The banner is an absolute S3 URL, so it needs no metadataBase. Omitted
      // entirely when the event has none, rather than falling back to an image
      // that belongs to something else.
      ...(event.bannerUrl ? { images: [{ url: event.bannerUrl, alt: event.title }] } : {}),
    },
    twitter: {
      card: event.bannerUrl ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(event.bannerUrl ? { images: [event.bannerUrl] } : {}),
    },
  }
}

export default async function PublicEventDetailPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  const resolved = await resolve(eventId)
  if (!resolved) notFound()

  const { tenant, event } = resolved
  const [branch, menu, branding, hasBracket] = await Promise.all([
    getPublicBranch(tenant.id),
    getPublicMenu(tenant.id),
    getPublishedBranding(tenant.id),
    // M15 #7 — offer the live link only once a draw exists.
    publicEventHasBracket(tenant.id, event.id),
  ])

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2
  const hasMenu = menu.some((c) => c.items.length > 0)

  const free = Number(event.entryFee) === 0
  const open = acceptsRegistrations(event.status)
  const soldOut = event.spotsLeft === 0

  const facts: { icon: typeof CalendarDays; label: string; value: string }[] = [
    { icon: CalendarDays, label: 'Date', value: formatEventDate(event.startsAt, tenant.timezone) },
    {
      icon: Clock,
      label: 'Time',
      value: `${formatEventTime(event.startsAt, tenant.timezone)} – ${formatEventTime(event.endsAt, tenant.timezone)}`,
    },
    ...(event.branchName ? [{ icon: MapPin, label: 'Venue', value: event.branchName }] : []),
    {
      icon: Users,
      label: 'Availability',
      value:
        event.capacity === null
          ? `Unlimited ${placesNoun(event.registrationMode, 2)}`
          : `${event.spotsLeft} of ${event.capacity} ${placesNoun(event.registrationMode, event.spotsLeft ?? 0)} left`,
    },
    ...(event.tournamentFormat
      ? [{ icon: Trophy, label: 'Format', value: TOURNAMENT_FORMAT_LABELS[event.tournamentFormat] }]
      : []),
  ]

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell
        tenantName={tenant.name}
        icon={<Icon size={18} />}
        logoUrl={branding.logoUrl}
        hasMenu={hasMenu}
      >
        <main className="flex-1 bg-background">
          <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
            <Link
              href="/events"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              <ArrowLeft size={15} aria-hidden /> All events
            </Link>

            {event.bannerUrl && (
              <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-primary/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={event.bannerUrl}
                  alt=""
                  className="aspect-[16/9] w-full object-cover sm:aspect-[21/9]"
                />
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                {EVENT_TYPE_LABELS[event.type]}
              </span>
              {open && !soldOut && (
                <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">
                  Registration open
                </span>
              )}
              {soldOut && (
                <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-700">
                  No places left
                </span>
              )}
            </div>

            <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{event.title}</h1>

            <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem]">
              <div>
                {event.description ? (
                  <div className="whitespace-pre-wrap text-base leading-relaxed text-foreground/90">
                    {event.description}
                  </div>
                ) : (
                  <p className="text-base text-muted-foreground">
                    Full details will be announced closer to the date.
                  </p>
                )}
              </div>

              <aside className="lg:sticky lg:top-24 lg:self-start">
                <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                  <p className="text-2xl font-bold">
                    {free ? 'Free entry' : formatMoney(event.entryFee, tenant.currency)}
                    {!free && event.registrationMode === 'team' && (
                      <span className="ml-1 text-sm font-medium text-muted-foreground">per team</span>
                    )}
                  </p>

                  <dl className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
                    {facts.map((f) => (
                      <div key={f.label} className="flex items-start gap-2.5">
                        <f.icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                        <div>
                          <dt className="text-muted-foreground">{f.label}</dt>
                          <dd className="font-medium text-foreground">{f.value}</dd>
                        </div>
                      </div>
                    ))}
                  </dl>

                  {/*
                    The CTA (M15 #3). A FULL event still gets a live link,
                    because "full" now has an answer — the waitlist — and turning
                    the button off would hide it. The lifecycle is still what
                    governs the button: a `published` (announced, not yet open)
                    event correctly shows "not open yet" rather than a dead link.

                    Where it lands decides nothing. /events/<id>/register asks
                    the customer to sign in if they are not, and every rule about
                    room, price and eligibility is applied inside
                    claim_event_registration() under the event lock — a page
                    rendered a minute ago cannot promise anybody a place.
                  */}
                  <div className="mt-5">
                    {open ? (
                      <Link
                        href={`/events/${event.id}/register`}
                        className="flex w-full items-center justify-center rounded-xl bg-primary px-4 py-3 text-base font-semibold text-primary-foreground transition hover:opacity-90"
                      >
                        {soldOut ? 'Join the waitlist' : 'Register'}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="w-full cursor-not-allowed rounded-xl bg-muted px-4 py-3 text-base font-semibold text-muted-foreground"
                      >
                        Registration not open yet
                      </button>
                    )}

                    {/* M15 #7 — the live bracket, offered only once a draw
                        actually exists. Linking unconditionally would send
                        spectators to an empty page before the tournament has
                        been drawn; `hasBracket` is a cheap count on the
                        already-indexed (event_id, …) key. The URL is stable and
                        public — the same one the venue puts on a screen. */}
                    {hasBracket && (
                      <Link
                        href={`/events/${event.id}/live`}
                        className="mt-3 flex w-full items-center justify-center rounded-xl border border-border px-4 py-3 text-base font-semibold transition hover:bg-muted"
                      >
                        Live bracket &amp; results
                      </Link>
                    )}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </main>

        <PublicFooter
          tenantName={tenant.name}
          industryLabel={industryLabel}
          icon={Icon}
          address={branch?.address ?? null}
          phone={branch?.phone ?? null}
        />
      </SitePageShell>
    </div>
  )
}
