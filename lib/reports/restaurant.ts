import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import { getSalesReport, type FoodSalesRow } from './sales'
import { buildFoodCostRows, foodCostPct, type FoodCostRow } from '@/lib/inventory/rules'
import { getModifierCostInputs, listMenuPrices, listRecipeRows, listStockCosts } from '@/lib/inventory/data'
import type { DateRange } from './date-range'
import {
  DAYPARTS,
  daypartOf,
  daysInRange,
  round2,
  safeDiv,
  tipPercent,
  turnsPerTablePerDay,
  SESSION_MINUTES_BOUNDS,
  type DaypartKey,
} from './restaurant-rules'

/**
 * Restaurant reports (M20 / AROS-179) — turnover, spend per cover, daypart,
 * menu-mix (+86s), void/comp and server performance, for a date range.
 *
 * ── BASES, STATED ONCE ──────────────────────────────────────────────────────
 * Money reports elsewhere (Revenue, Sales) are CASH basis: payments captured,
 * net of refunds (./revenue-basis.ts). The reports here that are about TABLES
 * answer "what did this table session ring up?", which is a billing question,
 * so they use BILLED sales: the sum of the session's live invoices
 * (`issued`/`paid`; void and draft excluded), `invoices.total`, which already
 * includes GST and service charge and EXCLUDES tips. Tips are reported beside
 * sales and never added to them (they are not revenue). Menu-mix is the one
 * exception — it reuses getSalesReport's food rows so the two screens can never
 * disagree on what a plate earned.
 *
 * A "session" is a table session: a booking with `resource_id` set, seated
 * (`checked_in_at` set), status checked_in/completed. Everything is dated by
 * when the party was SEATED, in the branch's timezone (tenant's if none).
 * Counter / takeaway orders with no table are not table service and are not
 * in these figures.
 *
 * Owner/manager only, restaurant tenants only, `module.reports` plan — all
 * enforced here so calling the reader directly cannot skip them.
 */

export type TurnoverTable = {
  tableName: string
  sessions: number
  finished: number
  avgMinutes: number | null
  turnsPerDay: number | null
}

export type DaypartRow = {
  key: DaypartKey
  label: string
  sessions: number
  covers: number
  billed: number
  spendPerCover: number | null
}

export type HourRow = { hour: number; sessions: number; covers: number; billed: number }

export type ServerRow = {
  serverId: string | null
  serverName: string
  sessions: number
  covers: number
  billed: number
  spendPerCover: number | null
  tips: number
  tipPct: number | null
}

export type VoidCompEntry = {
  id: string
  at: string
  kind: 'void' | 'comp'
  itemName: string
  qty: number
  amount: number
  staff: string
  reason: string
}

export type VoidCompStaffRow = { staff: string; voids: number; voidAmount: number; comps: number; compAmount: number }

export type MenuMixRow = FoodSalesRow & { eightySixed: number }

export type IngredientUseRow = {
  name: string
  unit: string
  used: number
  unitCost: number | null
  /** used × unitCost; 0 when the ingredient has no cost yet. */
  cost: number
}

export type RestaurantReport = {
  range: DateRange
  summary: {
    sessions: number
    covers: number
    billed: number
    tips: number
    spendPerCover: number | null
    avgSessionMinutes: number | null
    turnsPerTablePerDay: number | null
    tables: number
  }
  turnover: TurnoverTable[]
  daypart: DaypartRow[]
  hourly: HourRow[]
  menuMix: MenuMixRow[]
  voidComp: {
    voids: number
    voidAmount: number
    comps: number
    compAmount: number
    /** (void + comp amount) as a % of billed sales; null with no sales. */
    pctOfBilled: number | null
    byStaff: VoidCompStaffRow[]
    entries: VoidCompEntry[]
  }
  servers: ServerRow[]
  foodCost: {
    /** Ingredients deducted by sales in the range, priced at today's unit cost. */
    ingredients: IngredientUseRow[]
    /** Σ cost of the ingredients that have a cost. */
    cogs: number
    /** Ingredients used but not costed yet — COGS is a floor while this is above 0. */
    uncosted: number
    /** Paid food revenue in the range (same figure as Food & Memberships). */
    foodRevenue: number
    /** cogs ÷ foodRevenue; null with no revenue or nothing used. */
    pct: number | null
    /** Dishes that have a recipe, with cost per portion and food-cost %. */
    dishes: FoodCostRow[]
  }
}

const num = (v: unknown): number => Number(v ?? 0)

/** Table sessions seated in the range, one row each, with their billed sales and tips. */
function sessionsCte(tenantId: string, range: DateRange, branchId?: string | null): SQL {
  const tz = sql`coalesce(br.timezone, t.timezone)`
  const day = sql`((b.checked_in_at at time zone ${tz})::date)`
  return sql`
    sess as (
      select b.id, b.status, b.cover_count, b.server_id, r.name as table_name, b.resource_id,
             ${day} as local_day,
             extract(hour from (b.checked_in_at at time zone ${tz}))::int as hr,
             extract(epoch from (b.completed_at - b.checked_in_at)) / 60 as minutes,
             b.completed_at,
             coalesce(inv.billed, 0) as billed,
             coalesce(inv.tips, 0) as tips,
             (inv.booking_id is not null) as has_bill
        from public.bookings b
        join public.tenants t on t.id = b.tenant_id
        join public.branches br on br.id = b.branch_id
        join public.resources r on r.id = b.resource_id
        left join (
          select i.booking_id, sum(i.total) as billed, sum(i.tip_amount) as tips
            from public.invoices i
           where i.tenant_id = ${tenantId}
             and i.status in ('issued', 'paid')
             and i.booking_id is not null
           group by i.booking_id
        ) inv on inv.booking_id = b.id
       where b.tenant_id = ${tenantId}
         and b.resource_id is not null
         and b.checked_in_at is not null
         and b.status in ('checked_in', 'completed')
         and ${day} between ${range.start}::date and ${range.end}::date
         ${branchId ? sql`and b.branch_id = ${branchId}` : sql``}
    )`
}

export async function getRestaurantReport(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null },
): Promise<RestaurantReport> {
  if (!isManager(ctx.role)) throw new ReportAccessError('Only owners and managers can view reports.')
  if (ctx.tenant.industry !== 'restaurant') throw new ReportAccessError('Restaurant reports are for restaurant venues.')
  await requireEntitlement(ctx, 'module.reports')

  const { range, branchId } = options
  const tenantId = ctx.tenant.id
  const days = daysInRange(range.start, range.end)
  const { min, max } = SESSION_MINUTES_BOUNDS
  const finishedFilter = sql`status = 'completed' and completed_at is not null and minutes between ${min} and ${max}`

  const [tablesRes, turnRes, hourRes, serverRes, vcRes, eightySixRes, cogsRes, sales, stockCosts, recipeRows, menuPrices, modInputs] = await Promise.all([
    withUser(ctx.user.id, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n
          from public.resources r
          join public.resource_types rt on rt.id = r.resource_type_id
         where r.tenant_id = ${tenantId} and rt.hourly_rate = 0
           ${branchId ? sql`and r.branch_id = ${branchId}` : sql``}
      `),
    ),
    // Turnover: per table, over finished sessions.
    withUser(ctx.user.id, (tx) =>
      tx.execute(sql`
        with ${sessionsCte(tenantId, range, branchId)}
        select table_name,
               count(*)::int as sessions,
               count(*) filter (where ${finishedFilter})::int as finished,
               avg(minutes) filter (where ${finishedFilter})::float as avg_minutes
          from sess
         group by table_name
         order by table_name
      `),
    ),
    // Hourly: sessions/covers/billed by seated hour (daypart is folded from this).
    withUser(ctx.user.id, (tx) =>
      tx.execute(sql`
        with ${sessionsCte(tenantId, range, branchId)}
        select hr as hour,
               count(*)::int as sessions,
               coalesce(sum(cover_count) filter (where has_bill), 0)::int as covers,
               coalesce(sum(billed), 0)::float as billed
          from sess
         group by hr
         order by hr
      `),
    ),
    withUser(ctx.user.id, (tx) =>
      tx.execute(sql`
        with ${sessionsCte(tenantId, range, branchId)}
        select s.server_id::text as server_id,
               coalesce(m.full_name, m.email, 'Unassigned') as server_name,
               count(*)::int as sessions,
               coalesce(sum(s.cover_count) filter (where s.has_bill), 0)::int as covers,
               coalesce(sum(s.billed), 0)::float as billed,
               coalesce(sum(s.tips), 0)::float as tips
          from sess s
          left join public.memberships m on m.id = s.server_id
         group by s.server_id, m.full_name, m.email
         order by billed desc, server_name
      `),
    ),
    // Void / comp: the audit trail written when an item is voided or comped.
    withUser(ctx.user.id, (tx) =>
      tx.execute(sql`
        select a.id::text as id, a.action, a.created_at,
               coalesce(m.full_name, m.email, 'Unknown') as staff,
               coalesce((a.before->>'amount')::numeric, 0)::float as amount,
               coalesce(a.before->>'item_name', 'Item') as item_name,
               coalesce((a.before->>'qty')::int, 1) as qty,
               coalesce(a.after->>'reason', '') as reason
          from public.audit_log a
          join public.tenants t on t.id = a.tenant_id
          left join public.memberships m on m.id = a.actor_membership_id
          left join public.orders od on od.id = nullif(a.before->>'order_id', '')::uuid and od.tenant_id = a.tenant_id
          left join public.branches br on br.id = od.branch_id
         where a.tenant_id = ${tenantId}
           and a.action in ('order_item.void', 'order_item.comp')
           and ((a.created_at at time zone coalesce(br.timezone, t.timezone))::date)
               between ${range.start}::date and ${range.end}::date
           ${branchId ? sql`and od.branch_id = ${branchId}` : sql``}
         order by a.created_at desc
      `),
    ),
    // 86s: how often each item was marked out of stock.
    withUser(ctx.user.id, (tx) =>
      tx.execute(sql`
        select coalesce(a.after->>'item_name', 'Item') as item_name, count(*)::int as n
          from public.audit_log a
          join public.tenants t on t.id = a.tenant_id
         where a.tenant_id = ${tenantId}
           and a.action = 'menu_item.86'
           and ((a.created_at at time zone t.timezone)::date) between ${range.start}::date and ${range.end}::date
         group by 1
      `),
    ),
    // Food cost: what sales actually deducted (the 'order' movements) in the range.
    withUser(ctx.user.id, (tx) =>
      tx.execute(sql`
        select si.name, si.unit, si.unit_cost::float as unit_cost, (- sum(m.delta))::float as used
          from public.stock_movements m
          join public.stock_items si on si.id = m.stock_item_id and si.tenant_id = m.tenant_id
          join public.tenants t on t.id = m.tenant_id
         where m.tenant_id = ${tenantId}
           and m.source_type = 'order'
           and ((m.created_at at time zone t.timezone)::date) between ${range.start}::date and ${range.end}::date
           ${branchId ? sql`and si.branch_id = ${branchId}` : sql``}
         group by si.id, si.name, si.unit, si.unit_cost
         order by used desc, si.name
      `),
    ),
    getSalesReport(ctx, { range, branchId }),
    listStockCosts(ctx),
    listRecipeRows(ctx),
    listMenuPrices(ctx),
    getModifierCostInputs(ctx),
  ])

  // ── turnover ──────────────────────────────────────────────────────────────
  const tableCount = num(tablesRes.rows[0]?.n)
  const turnover: TurnoverTable[] = (turnRes.rows as Record<string, unknown>[]).map((r) => ({
    tableName: String(r.table_name),
    sessions: num(r.sessions),
    finished: num(r.finished),
    avgMinutes: r.avg_minutes === null ? null : round2(num(r.avg_minutes)),
    turnsPerDay: turnsPerTablePerDay(num(r.finished), 1, days),
  }))
  const finishedTotal = turnover.reduce((n, t) => n + t.finished, 0)
  const minutesWeighted = turnover.reduce((n, t) => n + (t.avgMinutes ?? 0) * t.finished, 0)

  // ── hourly + daypart ──────────────────────────────────────────────────────
  const hourly: HourRow[] = (hourRes.rows as Record<string, unknown>[]).map((r) => ({
    hour: num(r.hour),
    sessions: num(r.sessions),
    covers: num(r.covers),
    billed: round2(num(r.billed)),
  }))
  const daypart: DaypartRow[] = DAYPARTS.map((d) => {
    const rows = hourly.filter((h) => daypartOf(h.hour) === d.key)
    const covers = rows.reduce((n, h) => n + h.covers, 0)
    const billed = round2(rows.reduce((n, h) => n + h.billed, 0))
    const per = safeDiv(billed, covers)
    return {
      key: d.key,
      label: d.label,
      sessions: rows.reduce((n, h) => n + h.sessions, 0),
      covers,
      billed,
      spendPerCover: per === null ? null : round2(per),
    }
  })

  // ── servers ───────────────────────────────────────────────────────────────
  const servers: ServerRow[] = (serverRes.rows as Record<string, unknown>[]).map((r) => {
    const billed = round2(num(r.billed))
    const tips = round2(num(r.tips))
    const covers = num(r.covers)
    const per = safeDiv(billed, covers)
    return {
      serverId: (r.server_id as string | null) ?? null,
      serverName: String(r.server_name),
      sessions: num(r.sessions),
      covers,
      billed,
      spendPerCover: per === null ? null : round2(per),
      tips,
      tipPct: tipPercent(tips, billed),
    }
  })

  const billedTotal = round2(hourly.reduce((n, h) => n + h.billed, 0))
  const coversTotal = hourly.reduce((n, h) => n + h.covers, 0)
  const tipsTotal = round2(servers.reduce((n, s) => n + s.tips, 0))
  const perCover = safeDiv(billedTotal, coversTotal)
  const avgMin = safeDiv(minutesWeighted, finishedTotal)

  // ── void / comp ───────────────────────────────────────────────────────────
  const entries: VoidCompEntry[] = (vcRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    at: new Date(r.created_at as string).toISOString(),
    kind: r.action === 'order_item.comp' ? 'comp' : 'void',
    itemName: String(r.item_name),
    qty: num(r.qty),
    amount: round2(num(r.amount)),
    staff: String(r.staff),
    reason: String(r.reason),
  }))
  const byStaffMap = new Map<string, VoidCompStaffRow>()
  for (const e of entries) {
    const row = byStaffMap.get(e.staff) ?? { staff: e.staff, voids: 0, voidAmount: 0, comps: 0, compAmount: 0 }
    if (e.kind === 'void') {
      row.voids++
      row.voidAmount = round2(row.voidAmount + e.amount)
    } else {
      row.comps++
      row.compAmount = round2(row.compAmount + e.amount)
    }
    byStaffMap.set(e.staff, row)
  }
  const sum = (kind: 'void' | 'comp') => round2(entries.filter((e) => e.kind === kind).reduce((n, e) => n + e.amount, 0))
  const voidAmount = sum('void')
  const compAmount = sum('comp')
  const lost = safeDiv((voidAmount + compAmount) * 100, billedTotal)

  // ── menu mix (+ 86s) ──────────────────────────────────────────────────────
  const eightySix = new Map<string, number>(
    (eightySixRes.rows as Record<string, unknown>[]).map((r) => [String(r.item_name), num(r.n)]),
  )
  const menuMix: MenuMixRow[] = sales.food.map((f) => ({ ...f, eightySixed: eightySix.get(f.itemName) ?? 0 }))
  // An item that was 86'd but sold nothing in the window still belongs here.
  for (const [name, n] of eightySix) {
    if (!menuMix.some((m) => m.itemName === name)) {
      menuMix.push({ itemName: name, quantity: 0, grossRevenue: 0, invoices: 0, eightySixed: n })
    }
  }

  // ── food cost ─────────────────────────────────────────────────────────────
  const ingredients: IngredientUseRow[] = (cogsRes.rows as Record<string, unknown>[]).map((r) => {
    const unitCost = r.unit_cost === null ? null : num(r.unit_cost)
    const used = Math.round(num(r.used) * 1000) / 1000
    return { name: String(r.name), unit: String(r.unit), used, unitCost, cost: unitCost === null ? 0 : round2(used * unitCost) }
  })
  const cogs = round2(ingredients.reduce((n, i) => n + i.cost, 0))
  const foodRevenue = sales.totals.foodGrossRevenue
  const dishes = buildFoodCostRows({
    menu: menuPrices,
    stock: stockCosts,
    recipes: recipeRows,
    options: modInputs.options,
    optionRecipes: modInputs.optionRecipes,
    menuGroups: modInputs.menuGroups,
  })
    .filter((d) => d.hasRecipe)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))

  return {
    range,
    summary: {
      sessions: hourly.reduce((n, h) => n + h.sessions, 0),
      covers: coversTotal,
      billed: billedTotal,
      tips: tipsTotal,
      spendPerCover: perCover === null ? null : round2(perCover),
      avgSessionMinutes: avgMin === null ? null : round2(avgMin),
      turnsPerTablePerDay: turnsPerTablePerDay(finishedTotal, tableCount, days),
      tables: tableCount,
    },
    turnover,
    daypart,
    hourly,
    menuMix,
    voidComp: {
      voids: entries.filter((e) => e.kind === 'void').length,
      voidAmount,
      comps: entries.filter((e) => e.kind === 'comp').length,
      compAmount,
      pctOfBilled: lost === null ? null : round2(lost),
      byStaff: [...byStaffMap.values()].sort((a, b) => b.voidAmount + b.compAmount - (a.voidAmount + a.compAmount)),
      entries,
    },
    servers,
    foodCost: {
      ingredients,
      cogs,
      uncosted: ingredients.filter((i) => i.unitCost === null).length,
      foodRevenue,
      pct: ingredients.length === 0 ? null : foodCostPct(cogs, foodRevenue),
      dishes,
    },
  }
}
