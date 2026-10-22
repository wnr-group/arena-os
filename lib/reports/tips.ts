import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import type { DateRange } from './date-range'
import { round2 } from './restaurant-rules'

/**
 * Tips report (M20 / AROS-181): the tips collected in a date range, by server
 * and by day. Attribution and the "what counts" rules are the ones the payout
 * uses (lib/tips/service.ts): captured payments on live invoices, recipient =
 * the explicitly named person, else the table's server, else unattributed.
 * Tips are NOT revenue and appear nowhere in the revenue reports.
 *
 * Owner/manager only, restaurant tenants only, `module.tips` plan.
 */

export type TipServerRow = { serverId: string | null; serverName: string; tips: number; payments: number }
export type TipDayRow = { date: string; tips: number; unattributed: number; payments: number }

export type TipsReport = {
  range: DateRange
  total: number
  unattributed: number
  payments: number
  byServer: TipServerRow[]
  byDay: TipDayRow[]
}

const num = (v: unknown): number => Number(v ?? 0)

export async function getTipsReport(ctx: ActiveContext, options: { range: DateRange }): Promise<TipsReport> {
  if (!isManager(ctx.role)) throw new ReportAccessError('Only owners and managers can view reports.')
  if (ctx.tenant.industry !== 'restaurant') throw new ReportAccessError('The tips report is for restaurant venues.')
  await requireEntitlement(ctx, 'module.tips')

  const { range } = options
  const tenantId = ctx.tenant.id

  const rows = await withUser(ctx.user.id, (tx) =>
    tx.execute(sql`
      select coalesce(p.tip_recipient_membership_id, bk.server_id)::text as server_id,
             coalesce(m.full_name, m.email, 'Unassigned') as server_name,
             ((p.created_at at time zone coalesce(br.timezone, t.timezone))::date)::text as day,
             sum(p.tip_amount)::float as tips,
             count(*)::int as payments
        from public.payments p
        join public.invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id
        join public.branches br on br.id = i.branch_id
        join public.tenants t on t.id = i.tenant_id
        left join public.bookings bk on bk.id = i.booking_id and bk.tenant_id = i.tenant_id
        left join public.memberships m on m.id = coalesce(p.tip_recipient_membership_id, bk.server_id)
       where p.tenant_id = ${tenantId}
         and p.status = 'captured'
         and p.tip_amount > 0
         and i.status <> 'void'
         and ((p.created_at at time zone coalesce(br.timezone, t.timezone))::date)
             between ${range.start}::date and ${range.end}::date
       group by 1, 2, 3
    `),
  )

  const serverMap = new Map<string, TipServerRow>()
  const dayMap = new Map<string, TipDayRow>()
  let total = 0
  let unattributed = 0
  let payments = 0
  for (const r of rows.rows as { server_id: string | null; server_name: string; day: string; tips: number; payments: number }[]) {
    const tips = num(r.tips)
    const n = num(r.payments)
    total += tips
    payments += n
    if (r.server_id === null) unattributed += tips

    const key = r.server_id ?? 'none'
    const s = serverMap.get(key) ?? { serverId: r.server_id, serverName: r.server_id === null ? 'Unattributed' : r.server_name, tips: 0, payments: 0 }
    s.tips += tips
    s.payments += n
    serverMap.set(key, s)

    const d = dayMap.get(r.day) ?? { date: r.day, tips: 0, unattributed: 0, payments: 0 }
    d.tips += tips
    d.payments += n
    if (r.server_id === null) d.unattributed += tips
    dayMap.set(r.day, d)
  }

  return {
    range,
    total: round2(total),
    unattributed: round2(unattributed),
    payments,
    byServer: [...serverMap.values()].map((s) => ({ ...s, tips: round2(s.tips) })).sort((a, b) => b.tips - a.tips || a.serverName.localeCompare(b.serverName)),
    byDay: [...dayMap.values()].map((d) => ({ ...d, tips: round2(d.tips), unattributed: round2(d.unattributed) })).sort((a, b) => a.date.localeCompare(b.date)),
  }
}
