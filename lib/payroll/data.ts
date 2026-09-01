import 'server-only'
import { asc, desc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships, salaryStructures, type SalaryComponent } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'

export type SalaryStructureRow = {
  id: string
  membershipId: string
  fullName: string | null
  email: string | null
  role: string
  base: string
  allowances: SalaryComponent[]
  deductions: SalaryComponent[]
  effectiveFrom: string
}

/**
 * Every salary structure ever set, across all staff — the owner's full
 * version history, newest-per-member first. Payroll (AROS-104) will instead
 * want "the one row effective as of a given date per membership"; that's a
 * different, narrower query this table's shape supports but doesn't need yet.
 */
export async function listSalaryStructures(ctx: ActiveContext) {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Payroll actually blocks.
  await requireEntitlement(ctx, 'module.payroll')

  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: salaryStructures.id,
        membershipId: salaryStructures.membershipId,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        base: salaryStructures.base,
        allowances: salaryStructures.allowances,
        deductions: salaryStructures.deductions,
        effectiveFrom: salaryStructures.effectiveFrom,
      })
      .from(salaryStructures)
      .innerJoin(memberships, eq(memberships.id, salaryStructures.membershipId))
      .where(eq(salaryStructures.tenantId, ctx.tenant.id))
      .orderBy(asc(memberships.fullName), desc(salaryStructures.effectiveFrom)),
  ) as Promise<SalaryStructureRow[]>
}
