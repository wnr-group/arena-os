import 'server-only'
import { and, asc, desc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships, salaryStructures, type SalaryComponent } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

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
export function listSalaryStructures(ctx: ActiveContext) {
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
