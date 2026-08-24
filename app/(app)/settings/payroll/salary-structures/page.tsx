import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
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

  const [structures, staff] = await Promise.all([listSalaryStructures(ctx), listActiveMembers(ctx)])

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Salary Structures</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Set each employee's base pay, allowances and deductions — the foundation payroll runs will compute from. Owner
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
