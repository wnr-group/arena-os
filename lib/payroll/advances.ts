import 'server-only'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { withUser } from '@/db'
import type * as schema from '@/db/schema'
import { memberships, employeeAdvances, employeeAdvanceRecoveries } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'

type Db = NodePgDatabase<typeof schema>

export type AdvanceRow = {
  id: string
  membershipId: string
  fullName: string | null
  email: string | null
  amount: string
  instalmentAmount: string
  note: string | null
  givenAt: string
  /** Sum of the recovery ledger for this advance — never stored, always derived. */
  recovered: number
  outstanding: number
}

/**
 * Every advance ever given, across all staff, with its outstanding balance
 * derived from the recovery ledger — same shape as getEmployeeAnalytics
 * (lib/reports/employees.ts): a GROUP BY subquery aggregated before joining,
 * so an advance with many recovery rows never inflates anything else.
 */
export async function listAdvances(ctx: ActiveContext) {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Payroll actually blocks.
  await requireEntitlement(ctx, 'module.payroll')

  return withUser(ctx.user.id, async (tx) => {
    const recoveredAgg = tx
      .select({
        advanceId: employeeAdvanceRecoveries.advanceId,
        recovered: sql<number>`coalesce(sum(${employeeAdvanceRecoveries.amount}), 0)::float`.as('recovered'),
      })
      .from(employeeAdvanceRecoveries)
      .where(eq(employeeAdvanceRecoveries.tenantId, ctx.tenant.id))
      .groupBy(employeeAdvanceRecoveries.advanceId)
      .as('recovered_agg')

    const rows = await tx
      .select({
        id: employeeAdvances.id,
        membershipId: employeeAdvances.membershipId,
        fullName: memberships.fullName,
        email: memberships.email,
        amount: employeeAdvances.amount,
        instalmentAmount: employeeAdvances.instalmentAmount,
        note: employeeAdvances.note,
        givenAt: employeeAdvances.givenAt,
        recovered: sql<number>`coalesce(${recoveredAgg.recovered}, 0)::float`,
      })
      .from(employeeAdvances)
      .innerJoin(memberships, eq(memberships.id, employeeAdvances.membershipId))
      .leftJoin(recoveredAgg, eq(recoveredAgg.advanceId, employeeAdvances.id))
      .where(eq(employeeAdvances.tenantId, ctx.tenant.id))
      .orderBy(asc(memberships.fullName), desc(employeeAdvances.givenAt))

    return rows.map((r) => ({ ...r, outstanding: Number(r.amount) - r.recovered })) as AdvanceRow[]
  })
}

/** Whether any recovery has ever been posted against an advance — deletion is blocked once true, to protect the ledger's integrity. */
export async function hasRecoveries(tx: Db, tenantId: string, advanceId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: employeeAdvanceRecoveries.id })
    .from(employeeAdvanceRecoveries)
    .where(and(eq(employeeAdvanceRecoveries.tenantId, tenantId), eq(employeeAdvanceRecoveries.advanceId, advanceId)))
    .limit(1)
  return rows.length > 0
}
