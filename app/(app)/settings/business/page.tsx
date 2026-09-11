import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isOwner } from '@/lib/auth/roles'
import { getBusinessProfile } from '@/lib/settings/business'
import { DEFAULT_INVOICE_PREFIX } from '@/lib/settings/business-profile'
import { listTaxRates } from '@/lib/tax-rates/data'
import { BusinessProfileForm } from '@/components/settings/BusinessProfileForm'
import { GoogleBusinessForm } from '@/components/settings/GoogleBusinessForm'
import { getGoogleConnectionStatus } from '@/lib/reviews/google-credentials'

export default async function BusinessSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — saveBusinessProfile() calls requireOwner() itself, and
  // the business_write RLS policy is owner-only on top of that.
  if (!isOwner(ctx.role)) redirect('/dashboard')

  // M18's service charge is restaurant-only (see
  // lib/settings/business-profile.ts's loadServiceChargeConfig, the actual
  // enforcement point) — not fetching tax rates for a non-restaurant tenant
  // is just avoiding a pointless query, the form itself hides the section.
  const isRestaurant = ctx.tenant.industry === 'restaurant'
  const [profile, taxRates] = await Promise.all([
    getBusinessProfile(ctx),
    isRestaurant ? listTaxRates(ctx) : Promise.resolve([]),
  ])
  // Never carries the client secret or refresh token — see the status type.
  const googleConnection = await getGoogleConnectionStatus(ctx.tenant.id)

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Business profile</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your legal identity as it appears on every GST invoice. Only the owner can
        change this.
      </p>
      <BusinessProfileForm
        initial={{
          legalName: profile?.legalName ?? '',
          gstin: profile?.gstin ?? '',
          address: profile?.address ?? '',
          logoUrl: profile?.logoUrl ?? '',
          invoicePrefix: profile?.invoicePrefix ?? DEFAULT_INVOICE_PREFIX,
          placeOfSupply: profile?.placeOfSupply ?? '',
          serviceChargePercent: profile?.serviceChargePercent ?? '0',
          serviceChargeTaxRateId: profile?.serviceChargeTaxRateId ?? '',
          whatsappGroupUrl: profile?.whatsappGroupUrl ?? '',
          whatsappGroupEnabled: profile?.whatsappGroupEnabled ?? false,
          googleReviewUrl: profile?.googleReviewUrl ?? '',
          googleReviewEnabled: profile?.googleReviewEnabled ?? false,
        }}
        tenantName={ctx.tenant.name}
        configured={profile !== null}
        taxRates={taxRates.map((t) => ({ id: t.id, name: t.name, percent: t.percent }))}
        isRestaurant={isRestaurant}
      />

      <GoogleBusinessForm
        timeZone={ctx.tenant.timezone}
        status={
          googleConnection
            ? {
                accountId: googleConnection.accountId,
                locationId: googleConnection.locationId,
                clientId: googleConnection.clientId,
                authorised: googleConnection.authorised,
                connectedAt: googleConnection.connectedAt.toISOString(),
                lastSyncedAt: googleConnection.lastSyncedAt?.toISOString() ?? null,
                lastSyncError: googleConnection.lastSyncError,
              }
            : null
        }
      />
    </div>
  )
}
