import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes } from '@/lib/booking/public-availability'
import { todayInZone } from '@/lib/booking/time'
import { BookingWizard } from '@/components/public-booking/BookingWizard'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  other: 'Business',
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

  return (
    <div>
      <header className="border-b border-border bg-card px-4 py-4 sm:px-0">
        <div className="mx-auto max-w-md sm:px-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {INDUSTRY_LABELS[tenant.industry] ?? 'Business'}
          </p>
          <h1 className="text-xl font-bold">{tenant.name}</h1>
        </div>
      </header>

      {!branch || resourceTypes.length === 0 ? (
        <p className="mx-auto max-w-md px-4 py-10 text-center text-sm text-muted-foreground">
          Online booking isn&apos;t set up for this venue yet.
        </p>
      ) : (
        <BookingWizard
          resourceTypes={resourceTypes}
          timeZone={tenant.timezone}
          today={todayInZone(tenant.timezone)}
        />
      )}
    </div>
  )
}
