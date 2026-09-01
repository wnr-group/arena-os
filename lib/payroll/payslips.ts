import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships, payslips, type SalaryComponent } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'

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
export async function listPayrollPeriods(ctx: ActiveContext) {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Payroll actually blocks.
  await requireEntitlement(ctx, 'module.payroll')

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

const payslipColumns = {
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
}

/** Every payslip generated for one period, across all staff. Owner/manager only, per payslips_manager_select RLS. */
export async function listPayslipsForPeriod(ctx: ActiveContext, period: string) {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Payroll actually blocks.
  await requireEntitlement(ctx, 'module.payroll')

  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select(payslipColumns)
      .from(payslips)
      .innerJoin(memberships, eq(memberships.id, payslips.membershipId))
      .where(and(eq(payslips.tenantId, ctx.tenant.id), eq(payslips.period, period)))
      .orderBy(memberships.fullName)
    return rows as PayslipRow[]
  })
}

/** The caller's own payslips, most recent period first — the self-service "My Payslips" list. */
export async function listMyPayslips(ctx: ActiveContext) {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Payroll actually blocks.
  await requireEntitlement(ctx, 'module.payroll')

  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select(payslipColumns)
      .from(payslips)
      .innerJoin(memberships, eq(memberships.id, payslips.membershipId))
      .where(and(eq(payslips.tenantId, ctx.tenant.id), eq(payslips.membershipId, ctx.membershipId)))
      .orderBy(desc(payslips.period))
    return rows as PayslipRow[]
  })
}

/**
 * One payslip by id, for the printable view. No explicit ownership check
 * here — payslips_self_select/payslips_manager_select RLS already scope
 * this to "your own row, or any row if you're owner/manager"; another
 * employee's id simply returns null, same as an unknown one (the invoice
 * receipt page's convention — the URL leaks nothing).
 */
export async function getPayslipById(ctx: ActiveContext, id: string) {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Payroll actually blocks.
  await requireEntitlement(ctx, 'module.payroll')

  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select(payslipColumns)
      .from(payslips)
      .innerJoin(memberships, eq(memberships.id, payslips.membershipId))
      .where(and(eq(payslips.tenantId, ctx.tenant.id), eq(payslips.id, id)))
      .limit(1)
    return (row as PayslipRow | undefined) ?? null
  })
}
