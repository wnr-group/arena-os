import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Building2, CalendarDays } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { getPublicEvents } from '@/lib/events/public'
import { publicTenantUrl } from '@/lib/tenant/subdomain'
import { INDUSTRY_ICONS, INDUSTRY_LABELS } from '@/components/public-booking/TenantHome'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { EventCard } from '@/components/public-booking/EventCard'

/**
 * The public events listing (M15 #2) — every upcoming event a visitor may see,
 * on the tenant's own subdomain, with no session.
 *
 * The tenant comes from the SUBDOMAIN (currentTenantSlug, set by proxy.ts) and
 * is resolved through getPublicTenantBySlug(); it is never read from a query
 * param or header. getPublicEvents() then reads under withPublicTenant(), where
 * events_public_select (0079) admits only published/registration_open rows of
 * that one tenant.
 */

/** Shared by the page and its metadata so the tenant is resolved identically. */
async function resolveTenant() {
  const slug = await currentTenantSlug()
  if (!slug) return null
  return getPublicTenantBySlug(slug)
}

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await resolveTenant()
  // An unknown/suspended tenant gets no descriptive metadata — the page itself
  // 404s, and this must not name a venue that is not open.
  if (!tenant) return { title: 'Events' }

  const title = `Events at ${tenant.name}`
  const description = `Upcoming tournaments, classes, meetups and parties at ${tenant.name}. See dates, entry fees and availability, and register online.`
  const url = publicTenantUrl(tenant.slug, '/events')

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: tenant.name, type: 'website' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function PublicEventsPage() {
  const tenant = await resolveTenant()
  if (!tenant) notFound()

  const [events, branch, menu, branding] = await Promise.all([
    getPublicEvents(tenant.id),
    getPublicBranch(tenant.id),
    getPublicMenu(tenant.id),
    getPublishedBranding(tenant.id),
  ])

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2
  const hasMenu = menu.some((c) => c.items.length > 0)

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell
        tenantName={tenant.name}
        icon={<Icon size={18} />}
        logoUrl={branding.logoUrl}
        hasMenu={hasMenu}
      >
        <main className="flex-1 bg-background">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
            <header>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">What&rsquo;s On</h1>
              <p className="mt-2 max-w-2xl text-base text-muted-foreground">
                Upcoming events at {tenant.name} — tournaments, classes, meetups and more.
              </p>
            </header>

            {events.length === 0 ? (
              <div className="mt-12 flex flex-col items-center rounded-2xl border border-dashed border-border py-16 text-center">
                <CalendarDays size={32} className="text-muted-foreground/50" aria-hidden />
                <p className="mt-4 text-lg font-semibold">No events scheduled right now</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Check back soon — new tournaments and sessions are announced here first.
                </p>
              </div>
            ) : (
              <ul className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {events.map((e) => (
                  <li key={e.id} className="h-full">
                    <EventCard event={e} currency={tenant.currency} timezone={tenant.timezone} />
                  </li>
                ))}
              </ul>
            )}
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
