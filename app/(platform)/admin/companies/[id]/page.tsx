import { notFound } from 'next/navigation'
import { getCompany } from '@/lib/platform/data'
import { getTenantSubscription, listPlans } from '@/lib/platform/plans/data'
import { getCurrentUser } from '@/lib/auth/session'
import { rootDomain } from '@/lib/tenant/subdomain'
import { CompanyManager } from '@/components/platform/CompanyManager'
import { SubscriptionPanel } from '@/components/platform/SubscriptionPanel'

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  const { id } = await params
  const company = await getCompany(id)
  if (!company) notFound()

  // Both readers enforce requirePlatformAdmin() themselves — see the note in
  // lib/platform/data.ts. The early return above is only about the payload.
  const [subscription, catalogue] = await Promise.all([getTenantSubscription(id), listPlans()])

  return (
    <>
      <CompanyManager
        domain={rootDomain()}
        tenant={{
          id: company.tenant.id,
          slug: company.tenant.slug,
          name: company.tenant.name,
          industry: company.tenant.industry,
          status: company.tenant.status,
          currency: company.tenant.currency,
          timezone: company.tenant.timezone,
        }}
        members={company.members.map((m) => ({
          id: m.id,
          role: m.role,
          status: m.status,
          fullName: m.fullName,
          email: m.email,
        }))}
      />

      <SubscriptionPanel
        tenantId={company.tenant.id}
        subscription={
          subscription && {
            planName: subscription.planName,
            billingPeriod: subscription.billingPeriod,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        }
        // Only sellable plans are offered. A retired plan keeps its existing
        // subscribers but must not be assignable to anyone new.
        plans={catalogue.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  )
}
