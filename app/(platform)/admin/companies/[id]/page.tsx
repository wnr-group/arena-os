import { notFound } from 'next/navigation'
import { getCompany } from '@/lib/platform/data'
import { getCurrentUser } from '@/lib/auth/session'
import { rootDomain } from '@/lib/tenant/subdomain'
import { CompanyManager } from '@/components/platform/CompanyManager'

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  const { id } = await params
  const company = await getCompany(id)
  if (!company) notFound()

  return (
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
  )
}
