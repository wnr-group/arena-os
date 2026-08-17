import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Building2, Boxes, Gamepad2, Glasses, Music4, Mic2, Radio, Users, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes, type PublicResourceType } from '@/lib/booking/public-availability'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
import { PublicFooter } from '@/components/public-booking/PublicFooter'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  other: 'Business',
}

const INDUSTRY_ICONS: Record<string, LucideIcon> = {
  gaming_cafe: Gamepad2,
  recording_studio: Mic2,
  podcast_studio: Radio,
  dance_studio: Music4,
  vr_centre: Glasses,
  other: Building2,
}

/**
 * The tenant's public, no-login "what we offer" page — every bookable
 * resource type at its primary branch, laid out as a browsable card grid.
 * Tenant is resolved from the subdomain the same way app/page.tsx does,
 * since app/(public)/layout.tsx can't hand computed props down to a page.
 */
export default async function ResourcesPage() {
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const branch = await getPublicBranch(tenant.id)
  const resourceTypes = branch ? await getPublicResourceTypes(tenant.id, branch.id) : []

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div className="flex min-h-screen flex-col">
      <PublicNavbar tenantName={tenant.name} icon={<Icon size={18} />} />

      <main className="flex-1 bg-background">
        <section className="relative overflow-hidden border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 h-72 w-[640px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-primary/10 blur-[110px]"
          />
          <div className="relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Boxes size={13} className="text-primary" /> What we offer
            </span>
            <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-5xl">
              <span className="bg-gradient-to-r from-foreground to-muted-foreground/80 bg-clip-text text-transparent">
                Explore our{' '}
              </span>
              <span className="bg-gradient-to-r from-primary to-violet-500 bg-clip-text text-transparent">spaces</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
              Browse everything <span className="font-semibold text-foreground">{tenant.name}</span> has to book —
              pick one to reserve your slot.
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          {resourceTypes.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-lg text-muted-foreground">Online booking isn&apos;t set up for this venue yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {resourceTypes.map((type) => (
                <ResourceTypeCard key={type.id} type={type} />
              ))}
            </div>
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
    </div>
  )
}

/**
 * A type groups one or more actual bookable units — the customer books a
 * unit, not the type (see /book/[resourceId]). One unit: the whole card is
 * a direct link to it. Several units (e.g. 5 PS5 stations): the card shows
 * a picker of the individual units instead of guessing one for them.
 */
function ResourceTypeCard({ type }: { type: PublicResourceType }) {
  const media = (
    <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-primary/5">
      {type.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={type.imageUrl}
          alt={type.name}
          loading="lazy"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-primary/30">
          <Boxes size={32} />
        </div>
      )}
    </div>
  )

  if (type.resources.length === 1) {
    const unit = type.resources[0]
    return (
      <Link
        href={`/book/${unit.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
      >
        {media}
        <div className="flex flex-1 flex-col p-5">
          <p className="line-clamp-1 text-lg font-bold text-foreground transition group-hover:text-primary">
            {type.name}
          </p>
          <p className="mt-2 min-h-10 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {type.description ?? ''}
          </p>
          <div className="mt-auto pt-4">
            {type.capacity != null && (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground/80">
                <Users size={12} /> Up to {type.capacity}
              </span>
            )}
          </div>
        </div>
      </Link>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {media}
      <div className="flex flex-1 flex-col p-5">
        <p className="line-clamp-1 text-lg font-bold text-foreground">{type.name}</p>
        <p className="mt-2 min-h-10 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {type.description ?? ''}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {type.resources.map((unit) => (
            <Link
              key={unit.id}
              href={`/book/${unit.id}`}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground transition hover:border-primary/40 hover:text-primary"
            >
              {unit.name}
            </Link>
          ))}
        </div>
        {type.capacity != null && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground/80">
            <Users size={12} /> Up to {type.capacity} per unit
          </p>
        )}
      </div>
    </div>
  )
}
