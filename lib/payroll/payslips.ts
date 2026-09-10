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

/**
 * The caller's own payslips, most recent period first — the self-service
 * "My Payslips" list.
 *
 * ── DELIBERATELY NOT GATED ON module.payroll ────────────────────────────────
 *
 * Every other reader in this file is. This one is not, and the difference is
 * WHOSE record it is.
 *
 * The entitlement model gates what a BUSINESS may do with its plan. An employee
 * is not the party that subscribed, did not choose the plan and cannot change
 * it — but a payslip is their personal financial document, routinely required
 * for a loan, a visa or a tax filing. Gating this meant that a tenant
 * downgrading, or simply letting a subscription lapse, retroactively cut every
 * one of its staff off from salary records ALREADY ISSUED to them. The people
 * penalised were the ones with no say in the decision.
 *
 * This is the same line entitlement-guard.ts already draws for limits —
 * "denial blocks CREATING new items … it never blocks reading what a tenant
 * already has" — applied to a module gate, and the same line the customer
 * portal (M9) draws by carrying no entitlement gate at all: a third party's
 * access to their own records is outside the plan model.
 *
 * What a downgrade still stops is everything that GENERATES payroll: all five
 * actions in lib/actions/payroll.ts, and listPayslipsForPeriod() above, which
 * is the manager's payroll console rather than anybody's own record. So the
 * plan still sells running payroll; it just cannot un-issue a payslip.
 *
 * RLS is untouched and remains the security boundary: payslips_self_select
 * (migration 0030) scopes this to the caller's own membership_id. Removing the
 * plan check does not widen who can see what by one row.
 */
export async function listMyPayslips(ctx: ActiveContext) {
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
 *
 * NOT gated on module.payroll, for the reason set out on listMyPayslips()
 * above: this is the printable form of a record already issued, and it is the
 * only way an employee can produce their payslip as a document. Gating it
 * would have made the list survive a downgrade while every payslip in it
 * 500'd, which is worse than either whole answer.
 *
 * It also serves a manager opening a colleague's payslip, which RLS permits
 * and this leaves alone. That is still a read of an existing record, not a use
 * of the payroll module: a manager on a downgraded plan cannot ENUMERATE
 * payslips — listPayslipsForPeriod() is gated — so the console does not come
 * back, only individual documents that are already known to exist.
 */
export async function getPayslipById(ctx: ActiveContext, id: string) {
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
