import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, UtensilsCrossed, Users, type LucideIcon } from 'lucide-react'
import type { PublicTenant } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { todayInZone } from '@/lib/booking/time'
import { formatMoney } from '@/lib/format'
import { BookingWizard } from '@/components/public-booking/BookingWizard'
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
 * The tenant's public-facing homepage — served at "/" on a tenant subdomain
 * (and, via a redirect, at the legacy /book path). No session required.
 */
export async function TenantHome({ tenant }: { tenant: PublicTenant }) {
  const branch = await getPublicBranch(tenant.id)
  const resourceTypes = branch ? await getPublicResourceTypes(tenant.id, branch.id) : []
  const open = branch !== null && resourceTypes.length > 0
  const menuCategories = await getPublicMenu(tenant.id)

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

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
              <a
                href="#book"
                className="mt-8 inline-flex items-center justify-center rounded-xl bg-primary px-7 py-3.5 text-base font-bold text-primary-foreground shadow-lg shadow-primary/20 transition hover:-translate-y-0.5 active:translate-y-0 hover:shadow-primary/30"
              >
                Book Now
              </a>
            )}
          </div>
        </section>

        {menuCategories.length > 0 && (
          <section id="menu" className="scroll-mt-16 border-b border-border bg-card/40">
            <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
              <div className="text-center">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <UtensilsCrossed size={13} className="text-primary" /> Menu
                </span>
                <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">What&apos;s cooking</h2>
                <p className="mx-auto mt-3 max-w-lg text-base text-muted-foreground leading-relaxed">
                  Fresh off the pass — browse what {tenant.name} is serving today.
                </p>
              </div>

              <div className="mt-10 space-y-10">
                {menuCategories.map((category) => (
                  <div key={category.id}>
                    <h3 className="text-xl font-bold tracking-tight">{category.name}</h3>
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {category.items.map((item) => (
                        <div
                          key={item.id}
                          className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                        >
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt=""
                              className="size-16 shrink-0 rounded-lg border border-border object-cover"
                            />
                          ) : (
                            <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                              <UtensilsCrossed size={22} />
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <p className="text-base font-bold transition group-hover:text-primary">{item.name}</p>
                              <p className="shrink-0 text-base font-bold text-primary">{formatMoney(item.price, tenant.currency)}</p>
                            </div>
                            {item.description && (
                              <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground leading-relaxed">{item.description}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {open && (
          <section id="resources" className="scroll-mt-16 border-b border-border">
            <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
              <h2 className="text-center text-3xl font-extrabold tracking-tight sm:text-4xl">What we offer</h2>
              <p className="mx-auto mt-3 max-w-lg text-center text-base text-muted-foreground leading-relaxed">
                Choose what to book — availability updates in real time.
              </p>
              <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {resourceTypes.map((t) => (
                  <a
                    key={t.id}
                    href="#book"
                    className="group rounded-xl border border-border bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                  >
                    <p className="text-lg font-bold transition group-hover:text-primary">{t.name}</p>
                    {t.description && <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t.description}</p>}
                    {t.capacity && (
                      <p className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground/80">
                        <Users size={12} /> Up to {t.capacity}
                      </p>
                    )}
                  </a>
                ))}
              </div>
            </div>
          </section>
        )}

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

        <section id="book" className="scroll-mt-16">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
            <h2 className="text-center text-3xl font-extrabold tracking-tight sm:text-4xl">Book your session</h2>
            {!open ? (
              <p className="mx-auto mt-8 max-w-lg text-center text-base text-muted-foreground">
                Online booking isn&apos;t set up for this venue yet.
              </p>
            ) : (
              <div className="mt-6">
                <BookingWizard resourceTypes={resourceTypes} timeZone={tenant.timezone} today={todayInZone(tenant.timezone)} />
              </div>
            )}
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
