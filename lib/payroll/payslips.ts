import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships, payslips, type SalaryComponent } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export type PayslipRow = {
  id: string
  membershipId: string
  fullName: string | null
  email: string | null
  period: string
  base: string
  allowances: SalaryComponent[]
  deductions: SalaryComponent[]
  daysInPeriod: number
  daysPresent: number
  gross: string
  deductionsTotal: string
  advanceInstalment: string
  netPay: string
}

export type PayrollPeriodSummary = { period: string; payslipCount: number; totalNetPay: number }

/** Every period a payroll run has ever produced payslips for, most recent first. */
export function listPayrollPeriods(ctx: ActiveContext) {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        period: payslips.period,
        payslipCount: sql<number>`count(*)::int`,
        totalNetPay: sql<number>`coalesce(sum(${payslips.netPay}), 0)::float`,
      })
      .from(payslips)
      .where(eq(payslips.tenantId, ctx.tenant.id))
      .groupBy(payslips.period)
      .orderBy(desc(payslips.period))
    return rows as PayrollPeriodSummary[]
  })
}

/** Every payslip generated for one period, across all staff. */
export function listPayslipsForPeriod(ctx: ActiveContext, period: string) {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: payslips.id,
        membershipId: payslips.membershipId,
        fullName: memberships.fullName,
        email: memberships.email,
        period: payslips.period,
        base: payslips.base,
        allowances: payslips.allowances,
        deductions: payslips.deductions,
        daysInPeriod: payslips.daysInPeriod,
        daysPresent: payslips.daysPresent,
        gross: payslips.gross,
        deductionsTotal: payslips.deductionsTotal,
        advanceInstalment: payslips.advanceInstalment,
        netPay: payslips.netPay,
      })
      .from(payslips)
      .innerJoin(memberships, eq(memberships.id, payslips.membershipId))
      .where(and(eq(payslips.tenantId, ctx.tenant.id), eq(payslips.period, period)))
      .orderBy(memberships.fullName)
    return rows as PayslipRow[]
  })
}
