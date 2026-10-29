/**
 * Tips — rules, period computation, the payout ledger (M20 / AROS-181).
 * Owner/manager only (RLS agrees). The arithmetic lives in ./rules.ts.
 *
 * Source of the money: `payments.tip_amount` (captured at checkout, M18) —
 * kept out of invoice totals and revenue. Attribution, in order:
 *   1. the payment's explicit `tip_recipient_membership_id`, if the cashier named one;
 *   2. the server stamped on the table session (`bookings.server_id`, floor sections);
 *   3. nobody (unattributed) — shared by hours among the pool roles.
 * Only `captured` payments on non-void invoices count; a tip on a refunded or
 * voided sale is not paid out. Dated by when the payment was taken, in the
 * branch's timezone.
 */
import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, tipPayouts, tipPeriods, tipSettings } from '@/db/schema'
import {
  DEFAULT_TIP_RULES,
  computeTipDistribution,
  isPeriodOver,
  isTipPeriod,
  periodRange,
  validateTipRules,
  type TipEntry,
  type TipPerson,
  type TipResult,
  type TipRules,
} from './rules'

type Db = NodePgDatabase<typeof schema>
export type TipActor = { tenantId: string; membershipId: string | null }

export class TipError extends Error {}

const num = (v: unknown): number => Number(v ?? 0)

export async function getTipRulesCore(tx: Db, tenantId: string): Promise<TipRules> {
  const [row] = await tx.select().from(tipSettings).where(eq(tipSettings.tenantId, tenantId)).limit(1)
  if (!row) return DEFAULT_TIP_RULES
  return { mode: row.mode, tipOutPct: Number(row.tipOutPct), poolRoles: row.poolRoles, tipOutRoles: row.tipOutRoles }
}

export async function saveTipRulesCore(tx: Db, a: TipActor, rules: TipRules): Promise<void> {
  const problem = validateTipRules(rules)
  if (problem) throw new TipError(problem)
  const before = await getTipRulesCore(tx, a.tenantId)
  const values = {
    mode: rules.mode,
    tipOutPct: rules.tipOutPct.toFixed(2),
    poolRoles: rules.poolRoles,
    tipOutRoles: rules.tipOutRoles,
    updatedBy: a.membershipId,
    updatedAt: new Date(),
  }
  await tx.insert(tipSettings).values({ tenantId: a.tenantId, ...values }).onConflictDoUpdate({ target: tipSettings.tenantId, set: values })
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'tip_settings.changed',
    entityType: 'tip_settings',
    entityId: a.tenantId,
    before: before as unknown as Record<string, unknown>,
    after: rules as unknown as Record<string, unknown>,
  })
}

/** Tips taken in the inclusive local-date range, per recipient (null = unattributed). */
export async function loadTipsByRecipient(
  tx: Db,
  tenantId: string,
  range: { start: string; end: string },
  branchId?: string | null,
): Promise<TipEntry[]> {
  const res = await tx.execute(sql`
    select coalesce(p.tip_recipient_membership_id, bk.server_id)::text as recipient,
           sum(p.tip_amount)::float as tips
      from public.payments p
      join public.invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id
      join public.branches br on br.id = i.branch_id
      join public.tenants t on t.id = i.tenant_id
      left join public.bookings bk on bk.id = i.booking_id and bk.tenant_id = i.tenant_id
     where p.tenant_id = ${tenantId}
       and p.status = 'captured'
       and p.tip_amount > 0
       and i.status <> 'void'
       and ((p.created_at at time zone coalesce(br.timezone, t.timezone))::date)
           between ${range.start}::date and ${range.end}::date
       ${branchId ? sql`and i.branch_id = ${branchId}` : sql``}
     group by 1
  `)
  return (res.rows as { recipient: string | null; tips: number }[]).map((r) => ({
    recipientId: r.recipient,
    amount: num(r.tips),
  }))
}

export type TipPersonInfo = TipPerson & { name: string }

/** Hours worked per member in the range, from attendance (clock-in AND clock-out). */
export async function loadHoursWorked(
  tx: Db,
  tenantId: string,
  range: { start: string; end: string },
): Promise<TipPersonInfo[]> {
  const res = await tx.execute(sql`
    select m.id::text as membership_id, m.role::text as role,
           coalesce(m.full_name, m.email, 'Team member') as name,
           coalesce(sum(
             least(24, extract(epoch from (a.clock_out - a.clock_in)) / 3600)
           ) filter (where a.clock_in is not null and a.clock_out is not null and a.clock_out > a.clock_in), 0)::float as hours
      from public.memberships m
      left join public.attendance a
        on a.membership_id = m.id
       and a.tenant_id = m.tenant_id
       and a.work_date between ${range.start}::date and ${range.end}::date
     where m.tenant_id = ${tenantId}
     group by m.id, m.role, m.full_name, m.email
  `)
  return (res.rows as { membership_id: string; role: string; name: string; hours: number }[]).map((r) => ({
    membershipId: r.membership_id,
    role: r.role,
    name: r.name,
    hours: Math.round(num(r.hours) * 100) / 100,
  }))
}

export type PeriodPreview = {
  period: string
  rules: TipRules
  people: TipPersonInfo[]
  result: TipResult
  /** Set once the month has been finalised (the frozen figures, not a recompute). */
  finalized: {
    finalizedAt: Date
    totalTips: number
    distributed: number
    undistributed: number
    settings: Record<string, unknown>
  } | null
  payouts: { membershipId: string; name: string; amount: number; status: 'pending' | 'paid'; breakdown: Record<string, number> }[]
}

/**
 * The month's tip distribution. If the month is finalised this returns the
 * FROZEN rows; otherwise it computes live from payments + attendance + the
 * current rules (a preview — nothing is written).
 */
export async function previewTipPeriodCore(tx: Db, tenantId: string, period: string): Promise<PeriodPreview> {
  if (!isTipPeriod(period)) throw new TipError('Pick a month (YYYY-MM).')
  const range = periodRange(period)
  const [rules, entries, people] = await Promise.all([
    getTipRulesCore(tx, tenantId),
    loadTipsByRecipient(tx, tenantId, range),
    loadHoursWorked(tx, tenantId, range),
  ])
  const nameOf = new Map(people.map((p) => [p.membershipId, p.name]))

  const [closed] = await tx
    .select()
    .from(tipPeriods)
    .where(and(eq(tipPeriods.tenantId, tenantId), eq(tipPeriods.period, period)))
    .limit(1)
  if (closed) {
    const rows = await tx
      .select()
      .from(tipPayouts)
      .where(and(eq(tipPayouts.tenantId, tenantId), eq(tipPayouts.period, period)))
    const frozenRules = closed.settings as unknown as TipRules
    return {
      period,
      rules: frozenRules,
      people,
      result: {
        payouts: [],
        totalTips: Number(closed.totalTips),
        distributed: Number(closed.distributed),
        undistributed: Number(closed.undistributed),
        unattributed: 0,
        tipOutSkipped: false,
      },
      finalized: {
        finalizedAt: closed.finalizedAt,
        totalTips: Number(closed.totalTips),
        distributed: Number(closed.distributed),
        undistributed: Number(closed.undistributed),
        settings: closed.settings,
      },
      payouts: rows
        .map((r) => ({ membershipId: r.membershipId, name: nameOf.get(r.membershipId) ?? 'Team member', amount: Number(r.amount), status: r.status, breakdown: r.breakdown }))
        .sort((x, y) => y.amount - x.amount),
    }
  }

  const rulesProblem = validateTipRules(rules)
  if (rulesProblem) throw new TipError(rulesProblem)
  const result = computeTipDistribution({ rules, tips: entries, people })
  return {
    period,
    rules,
    people,
    result,
    finalized: null,
    payouts: result.payouts.map((p) => ({
      membershipId: p.membershipId,
      name: nameOf.get(p.membershipId) ?? 'Team member',
      amount: p.total,
      status: 'pending' as const,
      breakdown: { own: p.own, poolShare: p.poolShare, tipOutReceived: p.tipOutReceived, tippedOut: p.tippedOut, hours: p.hours },
    })),
  }
}

/**
 * Close a month: freeze the rules and totals and write one payout row per
 * person. Only a finished month, and only once — a second call (or a race) hits
 * the tip_periods primary key. Payroll then pays these pending rows on the
 * payslip for the same period.
 */
export async function finalizeTipPeriodCore(
  tx: Db,
  a: TipActor,
  period: string,
  todayLocal: string,
): Promise<PeriodPreview> {
  if (!isTipPeriod(period)) throw new TipError('Pick a month (YYYY-MM).')
  if (!isPeriodOver(period, todayLocal)) throw new TipError('That month isn’t over yet — tips can be finalised once it has ended.')

  const [exists] = await tx
    .select({ period: tipPeriods.period })
    .from(tipPeriods)
    .where(and(eq(tipPeriods.tenantId, a.tenantId), eq(tipPeriods.period, period)))
    .for('update')
    .limit(1)
  if (exists) throw new TipError(`Tips for ${period} are already finalised.`)

  const rules = await getTipRulesCore(tx, a.tenantId)
  const problem = validateTipRules(rules)
  if (problem) throw new TipError(problem)

  const range = periodRange(period)
  const [entries, people] = await Promise.all([loadTipsByRecipient(tx, a.tenantId, range), loadHoursWorked(tx, a.tenantId, range)])
  const result = computeTipDistribution({ rules, tips: entries, people })

  await tx.insert(tipPeriods).values({
    tenantId: a.tenantId,
    period,
    settings: rules as unknown as Record<string, unknown>,
    totalTips: result.totalTips.toFixed(2),
    distributed: result.distributed.toFixed(2),
    undistributed: result.undistributed.toFixed(2),
    finalizedBy: a.membershipId,
  })
  if (result.payouts.length > 0) {
    await tx.insert(tipPayouts).values(
      result.payouts.map((p) => ({
        tenantId: a.tenantId,
        period,
        membershipId: p.membershipId,
        amount: p.total.toFixed(2),
        breakdown: { own: p.own, poolShare: p.poolShare, tipOutReceived: p.tipOutReceived, tippedOut: p.tippedOut, hours: p.hours },
      })),
    )
  }
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'tips.period_finalized',
    entityType: 'tip_period',
    entityId: null,
    before: {},
    after: { period, total: result.totalTips, distributed: result.distributed, undistributed: result.undistributed, people: result.payouts.length },
  })
  return previewTipPeriodCore(tx, a.tenantId, period)
}

/** Undo a finalisation — only while nothing has been paid out. */
export async function reopenTipPeriodCore(tx: Db, a: TipActor, period: string): Promise<void> {
  const [row] = await tx
    .select({ period: tipPeriods.period })
    .from(tipPeriods)
    .where(and(eq(tipPeriods.tenantId, a.tenantId), eq(tipPeriods.period, period)))
    .for('update')
    .limit(1)
  if (!row) throw new TipError('That month isn’t finalised.')
  const paid = await tx
    .select({ id: tipPayouts.id })
    .from(tipPayouts)
    .where(and(eq(tipPayouts.tenantId, a.tenantId), eq(tipPayouts.period, period), eq(tipPayouts.status, 'paid')))
    .limit(1)
  if (paid.length > 0) throw new TipError('Some of these tips have already been paid, so the month can’t be reopened.')
  await tx.delete(tipPeriods).where(and(eq(tipPeriods.tenantId, a.tenantId), eq(tipPeriods.period, period)))
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'tips.period_reopened',
    entityType: 'tip_period',
    entityId: null,
    before: { period },
    after: {},
  })
}

/** Mark a payout paid outside payroll (cash, or a person with no payslip). */
export async function markTipPayoutPaidCore(tx: Db, a: TipActor, payoutId: string): Promise<void> {
  const [row] = await tx
    .select({ id: tipPayouts.id, status: tipPayouts.status })
    .from(tipPayouts)
    .where(and(eq(tipPayouts.id, payoutId), eq(tipPayouts.tenantId, a.tenantId)))
    .for('update')
    .limit(1)
  if (!row) throw new TipError('Payout not found.')
  if (row.status === 'paid') return
  await tx.update(tipPayouts).set({ status: 'paid', paidAt: new Date() }).where(and(eq(tipPayouts.id, row.id), eq(tipPayouts.tenantId, a.tenantId)))
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'tips.payout_marked_paid',
    entityType: 'tip_payout',
    entityId: row.id,
    before: { status: 'pending' },
    after: { status: 'paid', via: 'manual' },
  })
}
