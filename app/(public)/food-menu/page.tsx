import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, UtensilsCrossed, type LucideIcon, Sparkles, ChefHat } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { FoodMenuClient } from '@/components/public-booking/FoodMenuClient'

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

  const [branch, categories, branding] = await Promise.all([
    getPublicBranch(tenant.id),
    getPublicMenu(tenant.id),
    getPublishedBranding(tenant.id),
  ])

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  const totalItems = categories.reduce((sum, cat) => sum + cat.items.length, 0)

  return (
    <div
      className="flex min-h-screen flex-col bg-background/50 selection:bg-primary/20 selection:text-primary"
      style={accentColorStyle(branding.accentColor)}
    >
      <PublicNavbar tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} />

      <main className="flex-1 bg-background relative">
        {/* Layered premium ambient glow elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
          <div
            aria-hidden="true"
            className="absolute left-1/4 -top-40 h-[450px] w-[450px] rounded-full bg-primary/10 blur-[130px] animate-pulse-glow"
          />
          <div
            aria-hidden="true"
            className="absolute right-1/4 top-1/4 h-[550px] w-[550px] rounded-full bg-primary/8 blur-[160px] animate-pulse-glow [animation-delay:3s]"
          />
          <div
            aria-hidden="true"
            className="absolute left-1/3 top-12 h-[350px] w-[350px] rounded-full bg-accent/20 blur-[110px] animate-float"
          />
        </div>

        <section className="relative z-10 overflow-hidden bg-gradient-to-b from-primary/5 via-transparent to-transparent">
          <div className="relative mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-24">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary shadow-sm shadow-primary/10 backdrop-blur-md">
              <Sparkles size={12} className="text-primary animate-pulse" /> Curated Menu
            </span>
            <h1 className="mt-8 text-4xl font-black tracking-tight sm:text-6xl md:text-7xl leading-none">
              <span className="bg-gradient-to-r from-foreground via-foreground to-muted-foreground/70 bg-clip-text text-transparent">
                What&apos;s cooking at<br />
              </span>
              <span className="bg-gradient-to-r from-primary via-primary to-accent-foreground bg-clip-text text-transparent drop-shadow-sm select-none">
                {tenant.name}
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg md:text-xl">
              Discover our carefully crafted culinary selection. Browse our items, check descriptions, and pick your favourites.
            </p>

            {/* Quick stats board */}
            {categories.length > 0 && (
              <div className="mx-auto mt-10 grid max-w-xl grid-cols-3 gap-3 rounded-2xl border border-border/60 bg-card/60 p-2 shadow-[0_8px_30px_rgb(0,0,0,0.02)] backdrop-blur-md sm:gap-4 sm:p-3">
                <div className="rounded-xl bg-background/50 py-3 px-1 transition-all duration-300 hover:bg-background/80">
                  <div className="text-xl font-black text-primary sm:text-2xl">{categories.length}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-0.5 sm:text-xs">
                    Categories
                  </div>
                </div>
                <div className="rounded-xl bg-background/50 py-3 px-1 transition-all duration-300 hover:bg-background/80">
                  <div className="text-xl font-black text-primary sm:text-2xl">{totalItems}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-0.5 sm:text-xs">
                    Delicacies
                  </div>
                </div>
                <div className="rounded-xl bg-background/50 py-3 px-1 transition-all duration-300 hover:bg-background/80 flex flex-col justify-center items-center">
                  <ChefHat size={18} className="text-primary animate-bounce mt-1" />
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-1.5 sm:text-xs">
                    Fresh Daily
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="relative z-10 mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
          {categories.length === 0 ? (
            <div className="py-20 text-center rounded-3xl border border-dashed border-border bg-card/40 backdrop-blur-sm shadow-inner max-w-xl mx-auto">
              <UtensilsCrossed className="mx-auto h-16 w-16 text-muted-foreground/30 animate-pulse" />
              <h3 className="mt-4 text-xl font-bold text-foreground">Menu is Offline</h3>
              <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
                We are currently updating our offerings. Check back soon to explore our delicious options!
              </p>
            </div>
          ) : (
            <FoodMenuClient categories={categories} tenant={tenant} />
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

