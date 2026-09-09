import Link from 'next/link'
import { Building2 } from 'lucide-react'
import { listCompanies } from '@/lib/platform/data'
import { listPlans } from '@/lib/platform/plans/data'
import { getCurrentUser } from '@/lib/auth/session'
import { rootDomain } from '@/lib/tenant/subdomain'
import { CreateCompanyButton } from '@/components/platform/CreateCompanyButton'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  other: 'Business',
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  trial: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  suspended: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  cancelled: 'bg-zinc-500/15 text-zinc-500',
}

export default async function AdminHome() {
  // Layout renders the "platform admins only" screen; return early so we never
  // fetch cross-tenant data for a non-admin (which would leak into the payload).
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  const companies = await listCompanies()
  const domain = rootDomain()

  // Creating a company REQUIRES choosing a plan — an admin-created tenant with
  // no subscription opens with payroll, expenses and reports refused (M16's
  // gates are fail-closed). Active plans only: a retired one exists to
  // grandfather the tenants already on it, never to start a new company.
  const plans = (await listPlans())
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice,
      annualPrice: p.annualPrice,
      currency: p.currency,
    }))

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {companies.length} onboarded · each isolated by subdomain and RLS.
          </p>
        </div>
        <CreateCompanyButton plans={plans} />
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border">
        {companies.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No companies yet. Create the first one.
          </div>
        ) : (
          <table className="w-full text-base">
            <thead className="border-b bg-muted/50 text-left text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Industry</th>
                <th className="px-4 py-3 font-medium">Members</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Building2 size={16} className="shrink-0 text-muted-foreground" />
                      <div>
                        <p className="font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.slug}.{domain}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {INDUSTRY_LABELS[c.industry] ?? c.industry}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{Number(c.memberCount)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[c.status] ?? ''}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/companies/${c.id}`} className="font-medium text-primary hover:underline">
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
