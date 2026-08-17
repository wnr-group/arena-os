import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, UtensilsCrossed, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { formatMoney } from '@/lib/format'
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
 * The tenant's public, no-login food & drinks menu — every active category
 * and available item, with photos and prices. Read-only: browsing, not
 * ordering (customer online ordering is a separate future feature). Tenant
 * is resolved from the subdomain the same way every other app/(public) page
 * does, since app/(public)/layout.tsx can't hand computed props to a page.
 * Doubles as a QR-code table menu — scan the code, land straight here.
 */
export default async function MenuPage() {
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const [branch, categories] = await Promise.all([getPublicBranch(tenant.id), getPublicMenu(tenant.id)])

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
              <UtensilsCrossed size={13} className="text-primary" /> Menu
            </span>
            <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-5xl">
              <span className="bg-gradient-to-r from-foreground to-muted-foreground/80 bg-clip-text text-transparent">
                What&apos;s cooking at{' '}
              </span>
              <span className="bg-gradient-to-r from-primary to-violet-500 bg-clip-text text-transparent">
                {tenant.name}
              </span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
              Browse what&apos;s on offer — pick your favourites before you arrive.
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
          {categories.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-lg text-muted-foreground">The menu isn&apos;t available online yet.</p>
            </div>
          ) : (
            <div className="space-y-12">
              {categories.map((category) => (
                <div key={category.id}>
                  <h2 className="text-2xl font-bold tracking-tight text-foreground">{category.name}</h2>
                  <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {category.items.map((item) => (
                      <div
                        key={item.id}
                        className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg"
                      >
                        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-primary/10">
                          {item.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.imageUrl}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-primary/30">
                              <UtensilsCrossed size={24} />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="font-bold text-foreground transition group-hover:text-primary">{item.name}</p>
                            <p className="shrink-0 font-bold text-primary">{formatMoney(item.price, tenant.currency)}</p>
                          </div>
                          {item.description && (
                            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                              {item.description}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
