/**
 * Restaurant reports (M20 / AROS-179) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-restaurant-reports.ts
 *
 * Seeds a known day of table sessions, invoices, tips, voids/comps and 86s and
 * checks every figure: turnover, spend per cover, daypart, menu-mix (+86s),
 * void/comp, server performance — plus range edges, excluded rows (cancelled
 * sessions, void invoices, other days, other tenants), the 86 audit trail, and
 * the manager / industry / plan gates.
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const near = (a: number | null, b: number, eps = 0.011) => a !== null && Math.abs(a - b) <= eps
const TZ = 'Asia/Kolkata'
const ROLES = ['owner', 'manager', 'cashier', 'floor_staff', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]
const DAY = '2026-09-15'
const PREV = '2026-09-14'

/** Local IST wall time on a date -> a UTC ISO instant (IST = UTC+5:30, no DST). */
const ist = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`)).toISOString()

async function main() {
  loadEnv()
  const rep = await import('../lib/reports/restaurant')
  const { ReportAccessError } = await import('../lib/reports/daily-revenue')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows

  async function makeTenant(slug: string, industry = 'restaurant', entitled = true) {
    const t = await q(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name, industry=$4 returning id`,
      [slug, `${slug} co`, TZ, industry],
    )
    const tenantId = t[0].id as string
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b[0].id as string
    const members = {} as Record<Role, { userId: string; membershipId: string }>
    for (const role of ROLES) {
      const u = await q(
        `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      const m = await q(
        `insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,$3,'active',$4)
         on conflict (tenant_id,user_id) do update set role=$3, status='active', full_name=$4 returning id`,
        [tenantId, u[0].id, role, `${role} person`],
      )
      members[role] = { userId: u[0].id, membershipId: m[0].id }
    }
    const rt = await q(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set hourly_rate='0' returning id`,
      [tenantId],
    )
    const tables: string[] = []
    for (const name of ['T1', 'T2', 'T3']) {
      const r = await q(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,sort_order) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, branchId, rt[0].id, name, Number(name.slice(1))],
      )
      tables.push(r[0].id)
    }
    if (entitled) await entitleTenant(ownerPool, tenantId)
    return { tenantId, branchId, members, tables, industry }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>
  const ctxOf = (t: T, role: Role) =>
    ({
      user: { id: t.members[role].userId },
      tenant: { id: t.tenantId, industry: t.industry, timezone: TZ, currency: 'INR', name: 'Test' },
      role,
      membershipId: t.members[role].membershipId,
    }) as never
  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, err: e, msg: e instanceof Error ? e.message : String(e) }
    }
  }

  const A = await makeTenant('testrestrepa')
  const B = await makeTenant('testrestrepb')
  const G = await makeTenant('testrestrepg', 'gaming_cafe')
  const N = await makeTenant('testrestrepn', 'restaurant', false)
  const ids = [A.tenantId, B.tenantId, G.tenantId, N.tenantId]
  for (const tbl of ['payments', 'invoice_items', 'invoices', 'audit_log', 'bookings']) {
    await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  }

  let seq = 0
  const s1 = A.members.floor_staff.membershipId
  const s2 = A.members.cashier.membershipId

  async function session(
    t: T,
    o: { table: number; covers: number | null; server: string | null; in: string; out?: string; status?: string; date?: string },
  ) {
    const date = o.date ?? DAY
    const r = await q(
      `insert into bookings (tenant_id,branch_id,booking_number,status,source,cover_count,resource_id,server_id,checked_in_at,completed_at)
       values ($1,$2,$3,$4,'walk_in',$5,$6,$7,$8,$9) returning id`,
      [t.tenantId, t.branchId, `BK-R-${++seq}`, o.status ?? (o.out ? 'completed' : 'checked_in'), o.covers, t.tables[o.table], o.server, ist(date, o.in), o.out ? ist(date, o.out) : null],
    )
    return r[0].id as string
  }
  async function invoice(t: T, bookingId: string, o: { total: number; tip?: number; status?: string; items?: { name: string; qty: number; line: number }[]; at?: string; payStatus?: string; tipTo?: string }) {
    const inv = await q(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,subtotal,total,tip_amount,status)
       values ($1,$2,$3,$4,$5,$5,$6,$7) returning id`,
      [t.tenantId, t.branchId, `INV-R-${++seq}`, bookingId, o.total, o.tip ?? 0, o.status ?? 'paid'],
    )
    for (const it of o.items ?? []) {
      await q(
        `insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,line_total,tax_rate) values ($1,$2,'food',$3,$4,$5,$6,0)`,
        [t.tenantId, inv[0].id, it.name, it.qty, it.line / it.qty, it.line],
      )
    }
    if ((o.status ?? 'paid') === 'paid') {
      await q(`insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,created_at,tip_amount,tip_recipient_membership_id) values ($1,$2,$3,'cash',$4,$5,$6,$7,$8)`, [
        t.tenantId, t.branchId, inv[0].id, o.total, o.payStatus ?? 'captured', o.at ?? ist(DAY, '15:00'), o.tip ?? 0, o.tipTo ?? null,
      ])
    }
    return inv[0].id as string
  }
  const audit = (t: T, action: string, who: string | null, before: object, after: object, at: string) =>
    q(`insert into audit_log (tenant_id,actor_membership_id,action,entity_type,before,after,created_at) values ($1,$2,$3,'order_item',$4,$5,$6)`, [
      t.tenantId, who, action, JSON.stringify(before), JSON.stringify(after), at,
    ])

  // ── seed one known day ────────────────────────────────────────────────────
  const b1 = await session(A, { table: 0, covers: 4, server: s1, in: '13:00', out: '14:00' }) // lunch, 60 min
  const b2 = await session(A, { table: 0, covers: 2, server: s1, in: '20:00', out: '21:30' }) // dinner, 90 min
  const b3 = await session(A, { table: 1, covers: 3, server: s2, in: '20:30', out: '22:00' }) // dinner, 90 min
  await session(A, { table: 2, covers: 2, server: null, in: '08:00' }) // breakfast, still open, no bill
  await session(A, { table: 2, covers: 6, server: s1, in: '12:00', out: '13:00', status: 'cancelled' }) // excluded
  const bPrev = await session(A, { table: 0, covers: 5, server: s1, in: '13:00', out: '14:00', date: PREV }) // other day
  await invoice(A, b1, { total: 2000, tip: 200, items: [{ name: 'Burger', qty: 5, line: 2000 }] })
  await invoice(A, b2, { total: 1000, tip: 50 })
  await invoice(A, b3, { total: 1500, tip: 0 })
  await invoice(A, b3, { total: 500, status: 'void' }) // struck off: must not count
  await invoice(A, bPrev, { total: 9999, tip: 999, at: ist(PREV, '15:00') })

  await audit(A, 'order_item.void', A.members.manager.membershipId, { amount: '100', item_name: 'Fries', qty: 1, booking_id: b1 }, { reason: 'Wrong order' }, ist(DAY, '13:30'))
  await audit(A, 'order_item.void', A.members.manager.membershipId, { amount: '50', item_name: 'Cola', qty: 2, booking_id: b2 }, { reason: 'Spilled' }, ist(DAY, '20:30'))
  await audit(A, 'order_item.comp', A.members.owner.membershipId, { amount: '200', item_name: 'Dessert', qty: 1, booking_id: b3 }, { reason: 'Birthday' }, ist(DAY, '21:00'))
  await audit(A, 'order_item.void', A.members.manager.membershipId, { amount: '777', item_name: 'Old', qty: 1, booking_id: bPrev }, { reason: 'x' }, ist(PREV, '13:30'))
  await audit(A, 'order_item.edit', A.members.manager.membershipId, { amount: '5000', item_name: 'Edit', qty: 1, booking_id: b1 }, {}, ist(DAY, '13:40'))
  await audit(A, 'menu_item.86', A.members.kitchen_staff.membershipId, {}, { item_name: 'Burger', status: 'out_of_stock' }, ist(DAY, '19:00'))
  await audit(A, 'menu_item.86', A.members.kitchen_staff.membershipId, {}, { item_name: 'Burger', status: 'out_of_stock' }, ist(DAY, '21:00'))
  await audit(A, 'menu_item.86', A.members.kitchen_staff.membershipId, {}, { item_name: 'Pasta', status: 'out_of_stock' }, ist(DAY, '20:00'))
  await audit(A, 'menu_item.un86', A.members.kitchen_staff.membershipId, {}, { item_name: 'Burger', status: 'available' }, ist(DAY, '22:00'))
  await audit(A, 'menu_item.86', A.members.kitchen_staff.membershipId, {}, { item_name: 'Burger', status: 'out_of_stock' }, ist(PREV, '19:00'))

  // tenant B: one big day that must never leak into A
  const bb = await session(B, { table: 0, covers: 9, server: B.members.floor_staff.membershipId, in: '13:00', out: '14:00' })
  await invoice(B, bb, { total: 50000, tip: 5000 })
  await audit(B, 'order_item.void', B.members.manager.membershipId, { amount: '9000', item_name: 'B', qty: 1, booking_id: bb }, {}, ist(DAY, '13:00'))

  const range = { start: DAY, end: DAY }
  const r = await rep.getRestaurantReport(ctxOf(A, 'manager'), { range })

  // ── summary ───────────────────────────────────────────────────────────────
  check('sessions: 4 seated that day (cancelled + other-day excluded)', r.summary.sessions === 4)
  check('billed sales = 2000+1000+1500 (void invoice and other tenants excluded)', near(r.summary.billed, 4500))
  check('guests billed = 4+2+3 (the open, unbilled table adds none)', r.summary.covers === 9)
  check('spend per guest = 4500 / 9 = 500', near(r.summary.spendPerCover, 500))
  check('tips = 200+50 (tips are not sales)', near(r.summary.tips, 250))
  check('avg table time = (60+90+90)/3 = 80 min', near(r.summary.avgSessionMinutes, 80))
  check('3 tables, 3 finished sessions, 1 day = 1 turn per table per day', r.summary.tables === 3 && near(r.summary.turnsPerTablePerDay, 1))

  // ── turnover ──────────────────────────────────────────────────────────────
  const tt = (n: string) => r.turnover.find((x) => x.tableName === n)
  check('T1: 2 finished sessions averaging 75 min', tt('T1')?.finished === 2 && near(tt('T1')?.avgMinutes ?? null, 75))
  check('T2: 1 session of 90 min', tt('T2')?.finished === 1 && near(tt('T2')?.avgMinutes ?? null, 90))
  check('T3: the open session counts as a session but is not "finished"', tt('T3')?.sessions === 1 && tt('T3')?.finished === 0 && tt('T3')?.avgMinutes === null)

  // ── daypart ───────────────────────────────────────────────────────────────
  const dp = (k: string) => r.daypart.find((d) => d.key === k)!
  check('breakfast: 1 session, no sales (open, unbilled)', dp('breakfast').sessions === 1 && dp('breakfast').billed === 0 && dp('breakfast').spendPerCover === null)
  check('lunch: 2000 over 4 guests = 500 each', dp('lunch').sessions === 1 && near(dp('lunch').billed, 2000) && near(dp('lunch').spendPerCover, 500))
  check('dinner: 2500 over 5 guests', dp('dinner').sessions === 2 && near(dp('dinner').billed, 2500) && dp('dinner').covers === 5)
  check('snacks / late night are empty, not missing', dp('snacks').sessions === 0 && dp('late_night').sessions === 0 && r.daypart.length === 5)
  check('dayparts add back to the total', near(r.daypart.reduce((n, d) => n + d.billed, 0), r.summary.billed))
  check('hourly rows exist for the seated hours (IST, not UTC)', r.hourly.some((h) => h.hour === 13) && r.hourly.some((h) => h.hour === 20) && r.hourly.some((h) => h.hour === 8))

  // ── menu mix ──────────────────────────────────────────────────────────────
  const burger = r.menuMix.find((m) => m.itemName === 'Burger')
  check('menu mix reuses the food-sales figures (5 burgers, 2000 paid)', burger?.quantity === 5 && near(burger?.grossRevenue ?? null, 2000))
  check('Burger was 86d twice in range (other day + un-86 excluded)', burger?.eightySixed === 2)
  const pasta = r.menuMix.find((m) => m.itemName === 'Pasta')
  check('an item 86d but never sold still appears, with zero sales', pasta?.eightySixed === 1 && pasta.quantity === 0)

  // ── void / comp ───────────────────────────────────────────────────────────
  check('voids: 2 worth 150', r.voidComp.voids === 2 && near(r.voidComp.voidAmount, 150))
  check('comps: 1 worth 200', r.voidComp.comps === 1 && near(r.voidComp.compAmount, 200))
  check('other days, edits and other tenants are not counted', r.voidComp.entries.length === 3)
  check('share of sales = 350 / 4500', near(r.voidComp.pctOfBilled, 7.78))
  const mgr = r.voidComp.byStaff.find((s) => s.staff === 'manager person')
  check('by staff: the manager has 2 voids, no comps', mgr?.voids === 2 && near(mgr?.voidAmount ?? null, 150) && mgr?.comps === 0)
  check('by staff: sorted by value, owner (200 comp) after manager (150 void)? biggest first', r.voidComp.byStaff[0].staff === 'owner person')
  check('entries carry item, reason and quantity', r.voidComp.entries.some((e) => e.itemName === 'Cola' && e.qty === 2 && e.reason === 'Spilled'))

  // ── servers ───────────────────────────────────────────────────────────────
  const sv = (id: string | null) => r.servers.find((s) => s.serverId === id)!
  check('server 1: 2 sessions, 6 guests, 3000 billed, 250 tips', sv(s1).sessions === 2 && sv(s1).covers === 6 && near(sv(s1).billed, 3000) && near(sv(s1).tips, 250))
  check('server 1: 500 per guest, tip 8.33%', near(sv(s1).spendPerCover, 500) && near(sv(s1).tipPct, 8.33))
  check('server 2: 1 session, 1500, no tips', sv(s2).sessions === 1 && near(sv(s2).billed, 1500) && near(sv(s2).tips, 0))
  check('nobody-assigned sessions are grouped as Unassigned', sv(null).serverName === 'Unassigned' && sv(null).sessions === 1)
  check('server sales add back to the total', near(r.servers.reduce((n, s) => n + s.billed, 0), r.summary.billed))
  check('sorted by sales, best server first', r.servers[0].serverId === s1)

  // ── range edges + isolation ───────────────────────────────────────────────
  const both = await rep.getRestaurantReport(ctxOf(A, 'owner'), { range: { start: PREV, end: DAY } })
  check('a two-day range adds the previous day', both.summary.sessions === 5 && near(both.summary.billed, 4500 + 9999))
  check('...and its turns per table per day divide by 2 days', near(both.summary.turnsPerTablePerDay, 4 / (3 * 2)))
  const empty = await rep.getRestaurantReport(ctxOf(A, 'owner'), { range: { start: '2026-01-01', end: '2026-01-02' } })
  check('an empty range gives zeros / nulls, not errors', empty.summary.sessions === 0 && empty.summary.spendPerCover === null && empty.summary.avgSessionMinutes === null && empty.servers.length === 0)
  const rb = await rep.getRestaurantReport(ctxOf(B, 'owner'), { range })
  check("tenant B sees only its own day (and A's data never leaks)", rb.summary.sessions === 1 && near(rb.summary.billed, 50000) && near(rb.voidComp.voidAmount, 9000))
  const lateEdge = await session(A, { table: 1, covers: 1, server: null, in: '23:50' })
  const edge = await rep.getRestaurantReport(ctxOf(A, 'owner'), { range })
  const nextDay = await rep.getRestaurantReport(ctxOf(A, 'owner'), { range: { start: '2026-09-16', end: '2026-09-16' } })
  check('a 23:50 IST seating is dated by the venue day (not UTC) and is late night', edge.summary.sessions === 5 && nextDay.summary.sessions === 0 && edge.daypart.find((d) => d.key === 'late_night')!.sessions === 1)
  void lateEdge


  // ── per-cover ignores sessions with unknown guest counts ──────────────────
  const D2 = '2026-09-20'
  const pcA = await session(A, { table: 0, covers: 4, server: s1, in: '13:00', out: '14:00', date: D2 })
  const pcB = await session(A, { table: 1, covers: null, server: s1, in: '13:30', out: '14:30', date: D2 })
  await invoice(A, pcA, { total: 400, at: ist(D2, '15:00') })
  await invoice(A, pcB, { total: 600, at: ist(D2, '15:00') })
  const pc = await rep.getRestaurantReport(ctxOf(A, 'manager'), { range: { start: D2, end: D2 } })
  check('unknown covers: all 1000 is still billed', near(pc.summary.billed, 1000) && pc.summary.sessions === 2)
  check('unknown covers: spend per guest = 400 / 4 = 100 (not 1000 / 4 = 250)', pc.summary.covers === 4 && near(pc.summary.spendPerCover, 100))
  check('unknown covers: the daypart row uses the same basis', near(pc.daypart.find((d) => d.key === 'lunch')!.spendPerCover, 100))
  check('unknown covers: the server row uses the same basis', near(pc.servers.find((x) => x.serverId === s1)!.spendPerCover, 100) && near(pc.servers.find((x) => x.serverId === s1)!.billed, 1000))

  // ── server tips reconcile with the tips report (incl. a refunded tip) ─────
  const D3 = '2026-09-21'
  const tipsRep = await import('../lib/reports/tips')
  const t1 = await session(A, { table: 0, covers: 2, server: s1, in: '13:00', out: '14:00', date: D3 })
  const t2 = await session(A, { table: 1, covers: 2, server: s1, in: '14:00', out: '15:00', date: D3 })
  const t3 = await session(A, { table: 2, covers: 2, server: s1, in: '20:00', out: '21:00', date: D3 })
  await invoice(A, t1, { total: 1000, tip: 100, at: ist(D3, '14:30') }) // s1's table
  await invoice(A, t2, { total: 500, tip: 40, at: ist(D3, '15:30'), payStatus: 'refunded' }) // refunded: not paid out
  await invoice(A, t3, { total: 800, tip: 30, at: ist(D3, '21:30'), tipTo: s2 }) // cashier named s2
  const tr = await tipsRep.getTipsReport(ctxOf(A, 'manager'), { range: { start: D3, end: D3 } })
  const sr = await rep.getRestaurantReport(ctxOf(A, 'manager'), { range: { start: D3, end: D3 } })
  const tipOf = (id: string) => sr.servers.find((x) => x.serverId === id)?.tips ?? 0
  check('tips: the refunded tipped payment is out of the total (100 + 30)', near(tr.total, 130))
  check('tips: server performance total equals the tips report total', near(sr.servers.reduce((n, x) => n + x.tips, 0), tr.total) && near(sr.summary.tips, tr.total))
  check('tips: each server matches the tips report (s1 = 100, s2 = 30 named by the cashier)', tr.byServer.every((x) => near(tipOf(x.serverId ?? ''), x.tips)) && near(tipOf(s1), 100) && near(tipOf(s2), 30))
  check('tips: a tipped person with no table that day still gets a row', sr.servers.some((x) => x.serverId === s2 && x.sessions === 0))

  // ── revenue by kind sums to net with a delivery fee ───────────────────────
  const D4 = '2026-09-22'
  const dr = await import('../lib/reports/daily-revenue')
  const dv = await q(
    `insert into invoices (tenant_id,branch_id,invoice_number,subtotal,tax_total,total,status) values ($1,$2,$3,130,6.5,136.5,'paid') returning id`,
    [A.tenantId, A.branchId, `INV-R-${++seq}`],
  )
  await q(`insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,line_total,tax_rate) values ($1,$2,'food','Burger',1,100,100,5),($1,$2,'delivery','Delivery fee',1,30,30,5)`, [A.tenantId, dv[0].id])
  await q(`insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,created_at) values ($1,$2,$3,'cash',136.5,'captured',$4)`, [A.tenantId, A.branchId, dv[0].id, ist(D4, '13:00')])
  const rev = { totals: dr.sumDailyRevenue(await dr.getDailyRevenue(ctxOf(A, 'owner'), { range: { start: D4, end: D4 } })) }
  const kinds = rev.totals.bookingRevenue + rev.totals.foodRevenue + rev.totals.membershipRevenue + rev.totals.serviceChargeRevenue
  check('delivery: net is 136.50', near(rev.totals.net, 136.5))
  check('delivery: booking + food + membership + service charge = net (the fee is folded into food)', near(kinds, rev.totals.net, 0.02) && near(rev.totals.foodRevenue, 136.5, 0.02))

  // ── gates ─────────────────────────────────────────────────────────────────
  for (const role of ['cashier', 'floor_staff', 'kitchen_staff'] as const) {
    const g = await attempt(() => rep.getRestaurantReport(ctxOf(A, role), { range }))
    check(`${role} is refused`, !g.ok && g.err instanceof ReportAccessError)
  }
  for (const role of ['owner', 'manager'] as const) {
    check(`${role} is allowed`, (await attempt(() => rep.getRestaurantReport(ctxOf(A, role), { range }))).ok)
  }
  const gg = await attempt(() => rep.getRestaurantReport(ctxOf(G, 'owner'), { range }))
  check('a non-restaurant tenant is refused server-side', !gg.ok && gg.err instanceof ReportAccessError)
  const nn = await attempt(() => rep.getRestaurantReport(ctxOf(N, 'owner'), { range }))
  check('a tenant whose plan lacks module.reports is refused', !nn.ok)

  for (const tbl of ['payments', 'invoice_items', 'invoices', 'audit_log', 'bookings']) {
    await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  }
  await q('delete from tenants where id = any($1)', [ids])
  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
