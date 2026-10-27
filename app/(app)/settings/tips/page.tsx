import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { todayInZone } from '@/lib/booking/time'
import { getTipRulesCore, previewTipPeriodCore } from '@/lib/tips/service'
import { isPeriodOver, isTipPeriod } from '@/lib/tips/rules'
import { TipsManager, type PeriodView } from '@/components/settings/TipsManager'

/** Month 'YYYY-MM' shifted by whole months. */
function shiftMonth(period: string, by: number): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export default async function TipsSettingsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.tips'))) redirect('/dashboard')

  const today = todayInZone(ctx.tenant.timezone)
  const thisMonth = today.slice(0, 7)
  const lastMonth = shiftMonth(thisMonth, -1)
  const { period: asked } = await searchParams
  const period = asked && isTipPeriod(asked) ? asked : lastMonth
  // This month plus the previous 11, newest first.
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth, -i))
  if (!months.includes(period)) months.push(period)

  const { rules, preview } = await withUser(ctx.user.id, async (tx) => ({
    rules: await getTipRulesCore(tx, ctx.tenant.id),
    preview: await previewTipPeriodCore(tx, ctx.tenant.id, period),
  }))

  const view: PeriodView = {
    period,
    finalized: preview.finalized !== null,
    finalizedAt: preview.finalized ? preview.finalized.finalizedAt.toISOString() : null,
    totalTips: preview.result.totalTips,
    distributed: preview.result.distributed,
    undistributed: preview.result.undistributed,
    unattributed: preview.result.unattributed,
    tipOutSkipped: preview.result.tipOutSkipped,
    canFinalize: isPeriodOver(period, today),
    rules: preview.rules,
    payouts: preview.payouts.map((p) => ({
      id: null,
      membershipId: p.membershipId,
      name: p.name,
      amount: p.amount,
      status: p.status,
      breakdown: p.breakdown,
    })),
  }

  // Payout row ids are needed for "Mark paid" once a month is finalised.
  if (view.finalized) {
    const ids = await withUser(ctx.user.id, (tx) =>
      tx.query.tipPayouts.findMany({ where: (t, { and, eq }) => and(eq(t.tenantId, ctx.tenant.id), eq(t.period, period)), columns: { id: true, membershipId: true } }),
    )
    const idByMember = new Map(ids.map((i) => [i.membershipId, i.id]))
    view.payouts = view.payouts.map((p) => ({ ...p, id: idByMember.get(p.membershipId) ?? null }))
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Tips</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Decide how tips are shared, then pay them out each month through payroll. The amounts are worked out from tips taken at checkout, the
        server on each table, and hours clocked in.
      </p>
      <TipsManager rules={rules} period={period} months={months} view={view} currency={ctx.tenant.currency} />
    </div>
  )
}
