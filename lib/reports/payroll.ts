import 'server-only'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships, payslips } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'

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
 * No security_barrier view, deliberately. The AROS-64 reporting infrastructure
 * DOES exist (db/migrations/0043_reporting.sql: mv_daily_revenue behind
 * v_daily_revenue), but it exists for REVENUE — a pre-aggregated snapshot over
 * invoices, refreshed out of band. Payslips need neither half of that: they are
 * already one row per employee per month, so there is nothing to pre-aggregate,
 * and a manager asking for this month's wage bill wants it live rather than as
 * of the last refresh.
 *
 * So this follows the plain RLS-scoped aggregate pattern its siblings use
 * (getEmployeeAnalytics in lib/reports/employees.ts). Tenant isolation comes
 * from payslips_manager_select RLS (0030_payslips_self_view.sql), same as every
 * other reader in this module.
 *
 * (An earlier version of this comment said AROS-64 "was never built". That was
 * true when it was written; migration 0043 landed afterwards.)
 */
export async function getPayrollCostReport(ctx: ActiveContext, fromPeriod: string, toPeriod: string): Promise<PayrollCostReport> {
  // Defence in depth, matching the rest of lib/reports: the PAGE redirects a
  // non-manager and payslips_manager_select RLS would return nothing anyway,
  // but a reader callable from anywhere should refuse on its own account rather
  // than relying on every caller being careful.
  requireReportAccess(ctx)
  // Module gate (M16 #2): the plan must include Reports. Authoritative —
  // the page redirects for presentation, this is what actually refuses.
  await requireEntitlement(ctx, 'module.reports')

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

function requireReportAccess(ctx: ActiveContext): void {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }
}
