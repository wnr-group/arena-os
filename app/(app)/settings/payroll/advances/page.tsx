import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isOwner } from '@/lib/auth/roles'
import { listAdvances } from '@/lib/payroll/advances'
import { listActiveMembers } from '@/lib/memberships/data'
import { AdvancesManager } from '@/components/settings/AdvancesManager'

export default async function AdvancesSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — recordAdvance()/deleteAdvance() call requireOwner()
  // themselves, and the employee_advances_owner_rw RLS policy is owner-only
  // on top of that, for both read and write.
  if (!isOwner(ctx.role)) redirect('/dashboard')

  const [advances, staff] = await Promise.all([listAdvances(ctx), listActiveMembers(ctx)])

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Advances &amp; Loans</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Record an advance and its recovery schedule — payroll runs deduct the instalment until it's repaid. Owner
        only.
      </p>
      <AdvancesManager
        advances={advances}
        staff={staff.map((s) => ({ id: s.id, fullName: s.fullName, email: s.email }))}
        currency={ctx.tenant.currency}
      />
    </div>
  )
}
