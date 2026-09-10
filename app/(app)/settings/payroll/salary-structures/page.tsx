import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { isOwner } from '@/lib/auth/roles'
import { listSalaryStructures } from '@/lib/payroll/data'
import { listActiveMembers } from '@/lib/memberships/data'
import { SalaryStructuresManager } from '@/components/settings/SalaryStructuresManager'

export default async function SalaryStructuresSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — upsertSalaryStructure()/deleteSalaryStructure() call
  // requireOwner() themselves, and the salary_structures_owner_rw RLS policy
  // is owner-only on top of that, for both read and write.
  if (!isOwner(ctx.role)) redirect('/dashboard')
  // Plan gate (M16 #2). PRESENTATION ONLY — the readers below and every
  // action in this module call requireEntitlement() themselves and throw.
  // This only turns that refusal into a redirect instead of an error page.
  if (!(await hasEntitlement(ctx, 'module.payroll'))) redirect('/dashboard')

  const [structures, staff] = await Promise.all([listSalaryStructures(ctx), listActiveMembers(ctx)])

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Salary Structures</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Set each employee&rsquo;s base pay, allowances and deductions — the foundation payroll runs will compute from. Owner
        only.
      </p>
      <SalaryStructuresManager
        structures={structures}
        staff={staff.map((s) => ({ id: s.id, fullName: s.fullName, email: s.email }))}
        currency={ctx.tenant.currency}
      />
    </div>
  )
}
