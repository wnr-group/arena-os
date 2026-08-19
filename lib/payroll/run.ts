import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import {
  memberships,
  salaryStructures,
  attendance,
  employeeAdvances,
  employeeAdvanceRecoveries,
  payslips,
  type SalaryComponent,
} from '@/db/schema'
import { round2 } from '@/lib/billing/pricing'

type Db = NodePgDatabase<typeof schema>

/** Payroll rule violations the owner should see verbatim. */
export class PayrollError extends Error {}

const PERIOD_RE = /^\d{4}-\d{2}$/

export function isValidPeriod(period: string): boolean {
  return PERIOD_RE.test(period)
}

/** Calendar days in `period` ('YYYY-MM') — the proration denominator. */
export function daysInPeriod(period: string): number {
  const [year, month] = period.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function periodStart(period: string): string {
  return `${period}-01`
}

function periodEnd(period: string): string {
  return `${period}-${String(daysInPeriod(period)).padStart(2, '0')}`
}

function componentTotal(items: SalaryComponent[]): number {
  return items.reduce((sum, c) => sum + Number(c.amount), 0)
}

export type PayslipResult = { membershipId: string; fullName: string | null; netPay: number }
export type SkippedResult = { membershipId: string; fullName: string | null; reason: string }
export type RunPayrollResult = { period: string; generated: PayslipResult[]; skipped: SkippedResult[] }

/**
 * Run payroll for one calendar month. Everything below shares the caller's
 * transaction (withUser() in the server action), so a failure anywhere — a
 * duplicate period, a constraint violation — leaves no payslip and no
 * advance-recovery row behind. See 0029_payroll_runs.sql for the schema and
 * idempotency reasoning this implements.
 *
 * Formula per active employee with a salary structure effective by the
 * period's end date:
 *   gross = (base + sum(allowances)) * daysPresent / daysInPeriod   — rounded
 *           once, not per-day, to avoid compounding rounding error.
 *   netBeforeAdvance = max(0, gross - sum(deductions))              — floored
 *           at 0 rather than ever printing a negative payslip.
 *   advanceInstalment = as much of the employee's outstanding advances
 *           (oldest first) as fits within netBeforeAdvance, each capped at
 *           its own instalment_amount and its own outstanding balance —
 *           payroll never recovers more than a payslip can actually afford.
 *   netPay = netBeforeAdvance - advanceInstalment
 *
 * Attendance proration uses calendar days in the month as the denominator
 * (not branch working days) — the simplest, most transparent convention, and
 * the one this ticket's scope settled on.
 */
export async function runPayroll(
  tx: Db,
  tenantId: string,
  period: string,
  actorMembershipId: string,
): Promise<RunPayrollResult> {
  if (!isValidPeriod(period)) throw new PayrollError('Enter a valid period (YYYY-MM).')

  const start = periodStart(period)
  const end = periodEnd(period)
  const totalDays = daysInPeriod(period)

  // ── idempotency: the friendly path. The unique (membership_id, period)
  // constraint on payslips is the hard guarantee if two runs ever race.
  const [already] = await tx
    .select({ id: payslips.id })
    .from(payslips)
    .where(and(eq(payslips.tenantId, tenantId), eq(payslips.period, period)))
    .limit(1)
  if (already) throw new PayrollError(`Payroll for ${period} has already been run.`)

  // ── active employees ───────────────────────────────────────────────────
  const staff = await tx
    .select({ id: memberships.id, fullName: memberships.fullName })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')))
  if (staff.length === 0) return { period, generated: [], skipped: [] }
  const staffIds = staff.map((s) => s.id)

  // ── latest salary structure effective by the period's end, per member ───
  // Ordered (member, effectiveFrom desc) so the first row seen per member in
  // the loop below is always the newest applicable version — no raw SQL
  // DISTINCT ON needed for what's a small, in-memory reduction anyway.
  const structureRows = await tx
    .select({
      membershipId: salaryStructures.membershipId,
      base: salaryStructures.base,
      allowances: salaryStructures.allowances,
      deductions: salaryStructures.deductions,
    })
    .from(salaryStructures)
    .where(
      and(
        eq(salaryStructures.tenantId, tenantId),
        inArray(salaryStructures.membershipId, staffIds),
        lte(salaryStructures.effectiveFrom, end),
      ),
    )
    .orderBy(asc(salaryStructures.membershipId), desc(salaryStructures.effectiveFrom))

  const structureByMember = new Map<
    string,
    { base: string; allowances: SalaryComponent[]; deductions: SalaryComponent[] }
  >()
  for (const r of structureRows) {
    if (!structureByMember.has(r.membershipId)) {
      structureByMember.set(r.membershipId, { base: r.base, allowances: r.allowances, deductions: r.deductions })
    }
  }

  // ── attendance for the period, per member ────────────────────────────────
  // count(distinct work_date) rather than count(*): attendance has no unique
  // constraint on (membership_id, work_date), so this stays correct even if a
  // duplicate row ever exists — money must not double-count a day.
  const attendanceRows = await tx
    .select({
      membershipId: attendance.membershipId,
      daysPresent:
        sql<number>`count(distinct ${attendance.workDate}) filter (where ${attendance.clockIn} is not null)::int`.as(
          'days_present',
        ),
    })
    .from(attendance)
    .where(
      and(
        eq(attendance.tenantId, tenantId),
        inArray(attendance.membershipId, staffIds),
        gte(attendance.workDate, start),
        lte(attendance.workDate, end),
      ),
    )
    .groupBy(attendance.membershipId)
  const attendanceByMember = new Map(attendanceRows.map((r) => [r.membershipId, r.daysPresent]))

  // ── outstanding advances given on/before the period, oldest first ───────
  // FOR UPDATE locks these rows for the life of the transaction: a second
  // payroll run (or a concurrent one for another period) touching the same
  // advance queues behind this one instead of both recovering from the same
  // outstanding balance, mirroring the booking lock in issueInvoiceForBooking.
  const advanceRows = await tx
    .select({
      id: employeeAdvances.id,
      membershipId: employeeAdvances.membershipId,
      amount: employeeAdvances.amount,
      instalmentAmount: employeeAdvances.instalmentAmount,
    })
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.tenantId, tenantId),
        inArray(employeeAdvances.membershipId, staffIds),
        lte(employeeAdvances.givenAt, end),
      ),
    )
    .orderBy(asc(employeeAdvances.givenAt))
    .for('update')

  const recoveredAgg = advanceRows.length
    ? await tx
        .select({
          advanceId: employeeAdvanceRecoveries.advanceId,
          recovered: sql<number>`coalesce(sum(${employeeAdvanceRecoveries.amount}), 0)::float`.as('recovered'),
        })
        .from(employeeAdvanceRecoveries)
        .where(
          and(
            eq(employeeAdvanceRecoveries.tenantId, tenantId),
            inArray(
              employeeAdvanceRecoveries.advanceId,
              advanceRows.map((a) => a.id),
            ),
          ),
        )
        .groupBy(employeeAdvanceRecoveries.advanceId)
    : []
  const recoveredByAdvance = new Map(recoveredAgg.map((r) => [r.advanceId, r.recovered]))

  const advancesByMember = new Map<string, { id: string; instalmentAmount: string; outstanding: number }[]>()
  for (const a of advanceRows) {
    const outstanding = round2(Number(a.amount) - (recoveredByAdvance.get(a.id) ?? 0))
    if (outstanding <= 0) continue
    const list = advancesByMember.get(a.membershipId) ?? []
    list.push({ id: a.id, instalmentAmount: a.instalmentAmount, outstanding })
    advancesByMember.set(a.membershipId, list)
  }

  // ── compute + write one payslip per employee with a salary structure ────
  const generated: PayslipResult[] = []
  const skipped: SkippedResult[] = []

  for (const member of staff) {
    const structure = structureByMember.get(member.id)
    if (!structure) {
      skipped.push({ membershipId: member.id, fullName: member.fullName, reason: 'No salary structure set.' })
      continue
    }

    const base = Number(structure.base)
    const allowancesTotal = componentTotal(structure.allowances)
    const deductionsTotal = round2(componentTotal(structure.deductions))
    const daysPresent = Math.min(attendanceByMember.get(member.id) ?? 0, totalDays)

    const gross = round2(((base + allowancesTotal) * daysPresent) / totalDays)
    const netBeforeAdvance = Math.max(0, round2(gross - deductionsTotal))

    let remainingBudget = netBeforeAdvance
    const recoveries: { advanceId: string; amount: number }[] = []
    for (const adv of advancesByMember.get(member.id) ?? []) {
      if (remainingBudget <= 0) break
      const applied = round2(Math.min(Number(adv.instalmentAmount), adv.outstanding, remainingBudget))
      if (applied <= 0) continue
      recoveries.push({ advanceId: adv.id, amount: applied })
      remainingBudget = round2(remainingBudget - applied)
    }
    const advanceInstalment = round2(recoveries.reduce((sum, r) => sum + r.amount, 0))
    const netPay = Math.max(0, round2(netBeforeAdvance - advanceInstalment))

    const [payslip] = await tx
      .insert(payslips)
      .values({
        tenantId,
        membershipId: member.id,
        period,
        base: base.toFixed(2),
        allowances: structure.allowances,
        deductions: structure.deductions,
        daysInPeriod: totalDays,
        daysPresent,
        gross: gross.toFixed(2),
        deductionsTotal: deductionsTotal.toFixed(2),
        advanceInstalment: advanceInstalment.toFixed(2),
        netPay: netPay.toFixed(2),
        createdBy: actorMembershipId,
      })
      .returning({ id: payslips.id })

    if (recoveries.length > 0) {
      await tx.insert(employeeAdvanceRecoveries).values(
        recoveries.map((r) => ({
          tenantId,
          advanceId: r.advanceId,
          amount: r.amount.toFixed(2),
          sourceType: 'payroll',
          sourceId: payslip.id,
          createdBy: actorMembershipId,
        })),
      )
    }

    generated.push({ membershipId: member.id, fullName: member.fullName, netPay })
  }

  return { period, generated, skipped }
}
