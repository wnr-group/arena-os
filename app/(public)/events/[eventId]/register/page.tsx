import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Building2, CalendarDays, MapPin, Users } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug, type PublicTenant } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { getPublicEventById, type PublicEvent } from '@/lib/events/public'
import {
  getMyEventParticipation,
  listEventTeamsForCustomer,
  listPublicEventTeams,
} from '@/lib/events/registrations'
import { EVENT_TYPE_LABELS, acceptsRegistrations, placesNoun } from '@/lib/events/types'
import { formatEventWindow } from '@/lib/events/format'
import { formatMoney } from '@/lib/format'
import { getCurrentCustomer } from '@/lib/auth/customer-session'
import { CUSTOMER_LOGIN_PATH } from '@/lib/auth/customer-guard'
import { INDUSTRY_ICONS, INDUSTRY_LABELS } from '@/components/public-booking/TenantHome'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { EventRegisterPanel } from '@/components/events/EventRegisterPanel'

/**
 * The registration page (M15 #3) — where the Register CTA on the event detail
 * page lands.
 *
 * ── Public route, signed-in action ──────────────────────────────────────────
 *
 * /events/* is a public route (proxy.ts), so a visitor with no session reaches
 * this page and sees the event, the price and the places left. What they cannot
 * do is register: every write goes through an OTP-authenticated customer, so an
 * anonymous visitor gets a sign-in link carrying `next` back to this page.
 *
 * That is a deliberate difference from the public booking flow, which captures
 * a phone number and finds-or-creates a customer from it. A phone field IS a
 * "register somebody else" field, and the ticket's rule is that a customer must
 * not be able to enter anyone but themselves. M9's OTP already proves the
 * number, so registration reuses it rather than adding a weaker second door.
 *
 * ── Nothing here decides anything ───────────────────────────────────────────
 *
 * The page renders state; it does not compute eligibility. Whether there is
 * room, whether this customer is already entered, what the fee is and whether
 * an entry lands `registered`, `waitlisted` or `pending_payment` are all
 * decided inside claim_event_registration() under the event lock. What the page
 * shows is a preview, and a preview that is out of date simply produces a
 * different — still correct — answer when the button is pressed.
 */

export const metadata: Metadata = {
  title: 'Register',
  // A registration page has nothing to offer a crawler, and indexing it would
  // put a per-customer state page in search results.
  robots: { index: false, follow: false },
}

async function resolve(
  eventId: string,
): Promise<{ tenant: PublicTenant; event: PublicEvent } | null> {
  const slug = await currentTenantSlug()
  if (!slug) return null
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) return null
  const event = await getPublicEventById(tenant.id, eventId)
  if (!event) return null
  return { tenant, event }
}

export default async function EventRegisterPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  const resolved = await resolve(eventId)
  // Same identical 404 the detail page gives: unknown, another tenant's, draft
  // and cancelled must be indistinguishable.
  if (!resolved) notFound()

  const { tenant, event } = resolved
  const customer = await getCurrentCustomer()

  const [branch, menu, branding, participation, teams] = await Promise.all([
    getPublicBranch(tenant.id),
    getPublicMenu(tenant.id),
    getPublishedBranding(tenant.id),
    customer ? getMyEventParticipation(customer.id, event.id) : Promise.resolve(null),
    event.registrationMode === 'team'
      ? customer
        ? listEventTeamsForCustomer(customer.id, event.id)
        : listPublicEventTeams(tenant.id, event.id)
      : Promise.resolve([]),
  ])

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2
  const hasMenu = menu.some((c) => c.items.length > 0)

  const free = Number(event.entryFee) === 0
  const open = acceptsRegistrations(event.status)

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell
        tenantName={tenant.name}
        icon={<Icon size={18} />}
        logoUrl={branding.logoUrl}
        hasMenu={hasMenu}
      >
        <main className="flex-1 bg-background">
          <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
            <Link
              href={`/events/${event.id}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              <ArrowLeft size={15} aria-hidden /> Back to event
            </Link>

            <div className="mt-5 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                {EVENT_TYPE_LABELS[event.type]}
              </span>
              <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{event.title}</h1>

              <dl className="mt-4 space-y-2 text-sm text-muted-foreground">
                <div className="flex items-start gap-2">
                  <dt className="sr-only">When</dt>
                  <CalendarDays size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <dd>{formatEventWindow(event.startsAt, event.endsAt, tenant.timezone)}</dd>
                </div>
                {event.branchName && (
                  <div className="flex items-start gap-2">
                    <dt className="sr-only">Venue</dt>
                    <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <dd>{event.branchName}</dd>
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

              <p className="mt-4 border-t border-border pt-4 text-xl font-bold">
                {free
                  ? 'Free entry'
                  : `${formatMoney(event.entryFee, tenant.currency)}${
                      event.registrationMode === 'team' ? ' per team' : ''
                    }`}
              </p>

              <div className="mt-5">
                {!open ? (
                  <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                    Registration is not open for this event yet.
                  </p>
                ) : !customer ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Sign in with your phone number to register. We use it to confirm your place and
                      to reach you about the event.
                    </p>
                    <Link
                      href={`${CUSTOMER_LOGIN_PATH}?next=${encodeURIComponent(`/events/${event.id}/register`)}`}
                      className="mt-4 flex w-full items-center justify-center rounded-xl bg-primary px-4 py-3 text-base font-semibold text-primary-foreground transition hover:opacity-90"
                    >
                      Sign in to register
                    </Link>
                  </>
                ) : (
                  <EventRegisterPanel
                    eventId={event.id}
                    eventTitle={event.title}
                    entryFee={event.entryFee}
                    currency={tenant.currency}
                    venueName={tenant.name}
                    registrationMode={event.registrationMode}
                    teamSize={event.teamSize}
                    spotsLeft={event.spotsLeft}
                    customerName={customer.name}
                    customerPhone={customer.phone}
                    participation={
                      participation
                        ? {
                            ...participation,
                            holdExpiresAt: participation.holdExpiresAt?.toISOString() ?? null,
                          }
                        : null
                    }
                    teams={teams}
                  />
                )}
              </div>
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
