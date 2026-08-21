import 'server-only'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships, payslips } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export type PayrollCostRow = {
  membershipId: string
  fullName: string | null
  email: string | null
  role: string
  payslipCount: number
  totalGross: number
  totalDeductions: number
  totalAdvanceRecovered: number
  totalNetPay: number
}

export type PayrollCostTotals = {
  payslipCount: number
  totalGross: number
  totalDeductions: number
  totalAdvanceRecovered: number
  totalNetPay: number
}

export type PayrollCostReport = { rows: PayrollCostRow[]; totals: PayrollCostTotals }

const emptyTotals: PayrollCostTotals = {
  payslipCount: 0,
  totalGross: 0,
  totalDeductions: 0,
  totalAdvanceRecovered: 0,
  totalNetPay: 0,
}

/**
 * Total payroll cost for [fromPeriod, toPeriod] ('YYYY-MM' each, inclusive),
 * aggregated from payslips (AROS-104) — the wage-bill line M12's P&L
 * (AROS-86: revenue − expenses − payroll) will read from here. Period strings
 * compare lexicographically the same as chronologically ('2026-02' <
 * '2026-11'), so plain gte/lte works without parsing.
 *
 * No security_barrier view: the M6-D "reporting infra" epic (AROS-64) this
 * ticket names as a dependency was never built in this codebase — the sibling
 * getEmployeeAnalytics() (lib/reports/employees.ts) already established the
 * pattern actually in use here instead, a plain RLS-scoped aggregate query
 * per request. This follows that same pattern rather than inventing the
 * unbuilt one. Tenant isolation comes from payslips_manager_select RLS
 * (0030_payslips_self_view.sql) same as every other reader in this module.
 */
export function getPayrollCostReport(ctx: ActiveContext, fromPeriod: string, toPeriod: string): Promise<PayrollCostReport> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        membershipId: payslips.membershipId,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        payslipCount: sql<number>`count(*)::int`,
        totalGross: sql<number>`coalesce(sum(${payslips.gross}), 0)::float`,
        totalDeductions: sql<number>`coalesce(sum(${payslips.deductionsTotal}), 0)::float`,
        totalAdvanceRecovered: sql<number>`coalesce(sum(${payslips.advanceInstalment}), 0)::float`,
        totalNetPay: sql<number>`coalesce(sum(${payslips.netPay}), 0)::float`,
      })
      .from(payslips)
      .innerJoin(memberships, eq(memberships.id, payslips.membershipId))
      .where(and(eq(payslips.tenantId, ctx.tenant.id), gte(payslips.period, fromPeriod), lte(payslips.period, toPeriod)))
      .groupBy(payslips.membershipId, memberships.fullName, memberships.email, memberships.role)
      .orderBy(asc(memberships.fullName))

    const totals = rows.reduce<PayrollCostTotals>(
      (acc, r) => ({
        payslipCount: acc.payslipCount + r.payslipCount,
        totalGross: acc.totalGross + r.totalGross,
        totalDeductions: acc.totalDeductions + r.totalDeductions,
        totalAdvanceRecovered: acc.totalAdvanceRecovered + r.totalAdvanceRecovered,
        totalNetPay: acc.totalNetPay + r.totalNetPay,
      }),
      { ...emptyTotals },
    )

    return { rows: rows as PayrollCostRow[], totals }
  })
}
