import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, Users, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes } from '@/lib/booking/public-availability'
import { todayInZone } from '@/lib/booking/time'
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

export default async function PublicBookingPage() {
  // The layout already resolves + 404s the tenant; this repeats the lookup,
  // but getPublicTenantBySlug is React-cache'd per request, so it's the same
  // underlying query, not a second round trip.
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const branch = await getPublicBranch(tenant.id)
  const resourceTypes = branch ? await getPublicResourceTypes(tenant.id, branch.id) : []
  const open = branch !== null && resourceTypes.length > 0

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div className="flex min-h-screen flex-col">
      <PublicNavbar tenantName={tenant.name} icon={<Icon size={18} />} />

      <main className="flex-1">
        <section id="home" className="scroll-mt-16 border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
          <div className="mx-auto max-w-5xl px-4 py-14 text-center sm:px-6 sm:py-20">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon size={13} className="text-primary" /> {industryLabel}
            </span>
            <h1 className="mt-5 text-3xl font-bold tracking-tight sm:text-5xl">{tenant.name}</h1>
            <p className="mx-auto mt-3 max-w-md text-base text-muted-foreground sm:text-lg">
              Reserve your spot in seconds — pick what you want, find a time, and you&apos;re in.
            </p>
            {open && (
              <a
                href="#book"
                className="mt-7 inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-base font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
              >
                Book Now
              </a>
            )}
          </div>
        </section>

        {open && (
          <section id="resources" className="scroll-mt-16 border-b border-border">
            <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
              <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">What we offer</h2>
              <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
                Choose what to book — availability updates in real time.
              </p>
              <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {resourceTypes.map((t) => (
                  <a
                    key={t.id}
                    href="#book"
                    className="group rounded-xl border border-border bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                  >
                    <p className="text-base font-semibold transition group-hover:text-primary">{t.name}</p>
                    {t.description && <p className="mt-1.5 text-sm text-muted-foreground">{t.description}</p>}
                    {t.capacity && (
                      <p className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground">
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
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">About {tenant.name}</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
              We&apos;re a {industryLabel.toLowerCase()} open for walk-ins and online bookings alike. Reserve ahead
              so your spot is guaranteed when you arrive.
            </p>
            {branch?.address && <p className="mt-4 text-sm text-muted-foreground">{branch.address}</p>}
          </div>
        </section>

        <section id="book" className="scroll-mt-16">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
            <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">Book your session</h2>
            {!open ? (
              <p className="mx-auto mt-8 max-w-md text-center text-sm text-muted-foreground">
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
