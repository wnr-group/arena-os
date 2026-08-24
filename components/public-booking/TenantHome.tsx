import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, type LucideIcon } from 'lucide-react'
import type { PublicTenant } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes } from '@/lib/booking/public-availability'
import { getPublishedWebsite } from '@/lib/website/public'
import { WebsitePage } from '@/components/public-booking/website/WebsitePage'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
import { PublicFooter } from '@/components/public-booking/PublicFooter'

export const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  other: 'Business',
}

export const INDUSTRY_ICONS: Record<string, LucideIcon> = {
  gaming_cafe: Gamepad2,
  recording_studio: Mic2,
  podcast_studio: Radio,
  dance_studio: Music4,
  vr_centre: Glasses,
  other: Building2,
}

/**
 * The tenant's public-facing homepage — served at "/" on a tenant subdomain
 * (and, via a redirect, at the legacy /book path). No session required.
 */
export async function TenantHome({ tenant }: { tenant: PublicTenant }) {
  const branch = await getPublicBranch(tenant.id)
  const resourceTypes = branch ? await getPublicResourceTypes(tenant.id, branch.id) : []
  const open = branch !== null && resourceTypes.length > 0

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  // A business that has published its own homepage (M13) gets that instead of
  // the default below. Every tenant that hasn't touched the builder yet — i.e.
  // everyone, until AROS-C/E ship — falls straight through unchanged.
  const website = await getPublishedWebsite(tenant.id)
  if (website) {
    return (
      <WebsitePage
        tenantName={tenant.name}
        icon={<Icon size={18} />}
        sections={website.sections}
        settings={website.settings}
        tenantId={tenant.id}
        branch={branch}
        currency={tenant.currency}
        footer={
          <PublicFooter
            tenantName={tenant.name}
            industryLabel={industryLabel}
            icon={Icon}
            address={branch?.address ?? null}
            phone={branch?.phone ?? null}
          />
        }
      />
    )
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PublicNavbar tenantName={tenant.name} icon={<Icon size={18} />} />

      <main className="flex-1">
        <section id="home" className="scroll-mt-16 border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
          <div className="mx-auto max-w-5xl px-4 py-14 text-center sm:px-6 sm:py-20">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon size={13} className="text-primary" /> {industryLabel}
            </span>
            <h1 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-6xl">{tenant.name}</h1>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground sm:text-xl leading-relaxed">
              Reserve your spot in seconds — pick what you want, find a time, and you&apos;re in.
            </p>
            {open && (
              <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                <a
                  href="/resources"
                  className="inline-flex items-center justify-center rounded-xl bg-primary px-7 py-3.5 text-base font-bold text-primary-foreground shadow-lg shadow-primary/20 transition hover:-translate-y-0.5 active:translate-y-0 hover:shadow-primary/30"
                >
                  Book Now
                </a>
              </div>
            )}
          </div>
        </section>

        <section id="about" className="scroll-mt-16 border-b border-border bg-card/40">
          <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
            <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">About {tenant.name}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg leading-relaxed">
              We&apos;re a {industryLabel.toLowerCase()} open for walk-ins and online bookings alike. Reserve ahead
              so your spot is guaranteed when you arrive.
            </p>
            {branch?.address && <p className="mt-4 text-sm font-medium text-muted-foreground/80">{branch.address}</p>}
          </div>
        </section>
      </main>

      <PublicFooter
        tenantName={tenant.name}
        industryLabel={industryLabel}
        icon={Icon}
        address={branch?.address ?? null}
        phone={branch?.phone ?? null}
      />
    </div>
  )
}
