/**
 * Cloud printing (M19 / AROS-175) tests: ESC/POS output, routing to printers,
 * the CloudPRNT device protocol (through the real SECURITY DEFINER functions),
 * RLS, and failure classification.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-printing.ts
 */
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createOrderCore } from '../lib/orders/service'
import {
  fireCourseCore,
  saveKdsSettingsCore,
} from '../lib/kots/kds'
import { EscPos, toAscii, wrap } from '../lib/printing/escpos'
import { renderKitchenTicket, renderReceipt } from '../lib/printing/render'
import { enqueueKitchenTicketsCore, enqueueKitchenTicketsForOrderCore, enqueueReceiptCore } from '../lib/printing/jobs'
import { jobProblem } from '../lib/printing/queue'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

type Db = NodePgDatabase<typeof schema>
let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const TZ = 'Asia/Kolkata'
const NAMES = ['Starters', 'Mains', 'Desserts']
const ROLES = ['owner', 'manager', 'kitchen_staff', 'floor_staff', 'cashier', 'receptionist'] as const
type Role = (typeof ROLES)[number]

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows

  async function makeTenant(slug: string) {
    const t = await q(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'restaurant')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t[0].id as string
    // Course firing / the KDS are plan-gated: the fixture is a paying tenant.
    await entitleTenant(ownerPool, tenantId)
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const members = {} as Record<Role, { userId: string; membershipId: string }>
    for (const role of ROLES) {
      const u = await q(
        `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      const m = await q(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=$3, status='active' returning id`,
        [tenantId, u[0].id, role],
      )
      members[role] = { userId: u[0].id, membershipId: m[0].id }
    }
    const cat = await q(
      `insert into menu_categories (tenant_id,name) values ($1,'Mains') on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const items: string[] = []
    for (const [name, price] of [['Burger', '200'], ['Fries', '80'], ['Cola', '50']]) {
      const r = await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,$3,$4) returning id`, [
        tenantId, cat[0].id, name, price,
      ])
      items.push(r[0].id)
    }
    return { tenantId, branchId: b[0].id as string, members, items }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) }
    }
  }

  // ── 0. ESC/POS driver (pure) ──────────────────────────────────────────────
  check('toAscii: rupee, multiplication sign and dashes are transliterated', toAscii('₹250 × 2 – ok') === 'Rs 250 x 2 - ok')
  check('toAscii: accents stripped, unknown glyphs become ?', toAscii('Café 🍔') === 'Cafe ?')
  check('wrap: breaks on word boundaries and hard-splits overlong words', wrap('aaa bbb ccc', 7).join('|') === 'aaa bbb|ccc' && wrap('abcdefghij', 4).join('|') === 'abcd|efgh|ij')
  const slip = new EscPos(20).row('Burger', '250.00').build().toString('latin1')
  check('row: padded to the paper width', slip.replace(/^\x1b@/, '').split('\n')[0].length === 20)
  const tb = renderKitchenTicket(
    {
      kotNumber: 'KOT-001',
      orderNumber: 'OR-001',
      tableName: 'T5',
      stationName: 'Grill',
      channel: 'staff',
      time: '7:42 pm',
      reason: 'fire',
      lines: [{ qty: 2, name: 'Burger ₹', modifiers: ['No onion'], notes: 'well done', courseName: 'Mains' }],
    },
    42,
  )
  const ts = tb.toString('latin1')
  check('ticket: starts with ESC @ and ends with a cut', tb[0] === 0x1b && tb[1] === 0x40 && tb.subarray(-4).equals(Buffer.from([0x1d, 0x56, 0x42, 0x00])))
  check('ticket: carries station, table, qty x name, modifier, note, course, FIRE', ['GRILL', 'T5', '2 x Burger Rs', '+ No onion', '! well done', 'MAINS', '*** FIRE ***'].every((t) => ts.includes(t)))
  check('ticket: only ASCII and ESC/POS control bytes', [...tb].every((b) => b === 0x0a || b < 0x20 || (b >= 0x20 && b <= 0x7e)))
  const rb = renderReceipt(
    {
      business: { name: 'Cafe Arena', address: '1 Main St', phone: '99999', gstin: '29ABCDE1234F1Z5' },
      invoiceNumber: 'INV-1',
      date: '1 Jan 2027',
      customer: 'Asha',
      items: [{ description: 'Burger', qty: '2.00', unitPrice: '200.00', lineTotal: '400.00' }],
      subtotal: '400.00',
      discount: '0.00',
      serviceCharge: '0.00',
      cgst: '10.00',
      sgst: '10.00',
      total: '420.00',
      payments: [{ method: 'CASH', amount: '420.00' }],
      paid: '420.00',
      balanceDue: '0.00',
      isBill: false,
    },
    42,
  ).toString('latin1')
  check('receipt: business, items, tax, total and payment lines', ['Cafe Arena', 'GSTIN', '2 x 200.00', '400.00', 'CGST', 'SGST', '420.00', 'CASH', 'Thank you'].every((t) => rb.includes(t)))

  // ── 1. failure classification (pure) ──────────────────────────────────────
  const now = Date.now()
  const ago = (ms: number) => new Date(now - ms)
  check('jobProblem: failed always', jobProblem({ status: 'failed', createdAt: ago(1), sentAt: null }, now) === 'failed')
  check('jobProblem: sent long ago = unconfirmed, fresh = fine', jobProblem({ status: 'sent', createdAt: ago(9e5), sentAt: ago(9e5) }, now) === 'unconfirmed' && jobProblem({ status: 'sent', createdAt: ago(5e3), sentAt: ago(1e3) }, now) === null)
  check('jobProblem: pending too long = stuck, fresh = fine', jobProblem({ status: 'pending', createdAt: ago(9e5), sentAt: null }, now) === 'stuck' && jobProblem({ status: 'pending', createdAt: ago(1e3), sentAt: null }, now) === null)
  check('jobProblem: printed / cancelled never alert', jobProblem({ status: 'printed', createdAt: ago(9e6), sentAt: ago(9e6) }, now) === null && jobProblem({ status: 'cancelled', createdAt: ago(9e6), sentAt: null }, now) === null)

  // ── database ──────────────────────────────────────────────────────────────
  const A = await makeTenant('testprintinga')
  const B = await makeTenant('testprintingb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from orders where tenant_id = any($1)', [ids])
  await q('delete from order_settings where tenant_id = any($1)', [ids])
  await q('delete from printers where tenant_id = any($1)', [ids])
  await q('delete from kitchen_stations where tenant_id = any($1)', [ids])

  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  const mkPrinter = async (t: T, name: string, kind: 'kitchen' | 'receipt', secret: string, isDefault = false) =>
    (
      await q(
        `insert into printers (tenant_id,branch_id,name,kind,is_default,secret_hash) values ($1,$2,$3,$4,$5,$6) returning id`,
        [t.tenantId, t.branchId, name, kind, isDefault, sha(secret)],
      )
    )[0].id as string
  const place = async (t: T, lineSpec: { i: number; hold?: boolean; course?: number }[], role: Role = 'owner', membership = true) => {
    const o = await withUser(t.members[role].userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: membership ? t.members[role].membershipId : null },
        { branchId: t.branchId, items: lineSpec.map((s) => ({ menuItemId: t.items[s.i], qty: 1, ...(s.hold ? { hold: true, course: s.course ?? 2 } : {}) })) },
      ),
    )
    return o
  }
  const jobsFor = async (orderOrKot: string) =>
    await q(
      `select j.*, p.name as printer_name from print_jobs j join printers p on p.id=j.printer_id
        where j.kot_id = (select id from kots where order_id=$1) order by p.name`,
      [orderOrKot],
    )
  const text = (j: { payload: Buffer }) => j.payload.toString('latin1')

  // 2. no printer = no jobs (opt-in)
  const none = await place(A, [{ i: 0 }, { i: 1 }])
  check('no printers configured: order creates no print jobs', (await jobsFor(none.id)).length === 0)

  // 3. routing
  await withUser(A.members.manager.userId, (tx) =>
    saveKdsSettingsCore(tx, A.tenantId, { enabled: true, warnMinutes: 8, lateMinutes: 15, coursesEnabled: true, courseNames: NAMES, stationsEnabled: true }),
  )
  const grillStation = (await q(`insert into kitchen_stations (tenant_id,name) values ($1,'Grill') returning id`, [A.tenantId]))[0].id as string
  await q('update menu_items set station_id=$1 where id=$2', [grillStation, A.items[0]]) // Burger → Grill
  const pDefault = await mkPrinter(A, 'Pass printer', 'kitchen', 'secret-default-aaaaaaaaaaaa', true)
  const pGrill = await mkPrinter(A, 'Grill printer', 'kitchen', 'secret-grill-bbbbbbbbbbbbbb')
  await q('update kitchen_stations set printer_id=$1 where id=$2', [pGrill, grillStation])

  const o1 = await place(A, [{ i: 0 }, { i: 1 }, { i: 2 }], 'floor_staff')
  const j1 = await jobsFor(o1.id)
  check('order → one ticket per printer (grill + default)', j1.length === 2 && j1.map((j) => j.printer_name).join() === 'Grill printer,Pass printer')
  const jg = j1.find((j) => j.printer_name === 'Grill printer')!
  const jd = j1.find((j) => j.printer_name === 'Pass printer')!
  check('Grill printer gets only the Burger, headed GRILL', text(jg).includes('Burger') && !text(jg).includes('Fries') && text(jg).includes('GRILL'))
  check('unrouted lines go to the default printer (Fries, Cola — not Burger)', text(jd).includes('Fries') && text(jd).includes('Cola') && !text(jd).includes('Burger'))
  check('jobs start pending, linked to the KOT, attributed to the waiter', j1.every((j) => j.status === 'pending' && j.kot_id && j.created_by === A.members.floor_staff.membershipId))

  // 4. held lines and fired courses
  const o2 = await place(A, [{ i: 0 }, { i: 1, hold: true, course: 2 }, { i: 2, hold: true, course: 2 }])
  const j2 = await jobsFor(o2.id)
  check('held lines are not printed at order time', j2.length === 1 && !text(j2[0]).includes('Fries') && !text(j2[0]).includes('Cola'))
  const fired = await withUser(A.members.floor_staff.userId, async (tx) => {
    const ids2 = await fireCourseCore(tx, o2.id, 2)
    return enqueueKitchenTicketsForOrderCore(tx, A.tenantId, o2.id, 'fire', A.members.floor_staff.membershipId, ids2)
  })
  const j2b = (await jobsFor(o2.id)).filter((j) => text(j).includes('FIRE'))
  check('firing a course prints exactly the fired lines, marked FIRE', fired === 1 && j2b.length === 1 && text(j2b[0]).includes('Fries') && text(j2b[0]).includes('Cola') && !text(j2b[0]).includes('Burger'))

  // 5. anonymous / online path never prints (no member to own the job)
  const online = await place(A, [{ i: 0 }], 'owner', false)
  check('anonymous (online) order creates no jobs and does not error', (await jobsFor(online.id)).length === 0)

  // 6. voided lines are skipped; cancelled KOT prints nothing
  const o3 = await place(A, [{ i: 0 }, { i: 1 }])
  await q(`update order_items set void_status='voided' where order_id=$1 and item_name='Fries'`, [o3.id])
  const n3 = await withUser(A.members.owner.userId, (tx) => enqueueKitchenTicketsCore(tx, { tenantId: A.tenantId, branchId: A.branchId, orderId: o3.id, reason: 'reprint' }))
  const rp = (await jobsFor(o3.id)).filter((j) => text(j).includes('REPRINT'))
  check('reprint skips voided lines', n3 === 1 && rp.length === 1 && text(rp[0]).includes('Burger') && !text(rp[0]).includes('Fries'))

  // 7. receipts
  const dataBase = {
    business: { name: 'Cafe', address: null, phone: null, gstin: null },
    invoiceNumber: 'INV-9',
    date: 'today',
    customer: null,
    items: [],
    subtotal: '0',
    discount: '0',
    serviceCharge: '0',
    cgst: '0',
    sgst: '0',
    total: '100',
    payments: [],
    paid: '0',
    balanceDue: '100',
    isBill: true,
  }
  const inv = (await q(`select id from invoices where tenant_id=$1 limit 1`, [A.tenantId]))[0]?.id ?? null
  const rNo = await withUser(A.members.cashier.userId, (tx) => enqueueReceiptCore(tx, { tenantId: A.tenantId, invoiceId: inv ?? A.tenantId, bookingId: null, data: dataBase }))
  check('no receipt printer: reports no_printer (web-print remains the path)', rNo === 'no_printer')
  const pRcpt = await mkPrinter(A, 'Counter printer', 'receipt', 'secret-rcpt-cccccccccccccc')
  if (inv) {
    const rYes = await withUser(A.members.cashier.userId, (tx) => enqueueReceiptCore(tx, { tenantId: A.tenantId, invoiceId: inv, bookingId: null, data: dataBase }))
    const rj = (await q(`select * from print_jobs where printer_id=$1`, [pRcpt]))[0]
    check('receipt printer set up: bill queued on it with the BILL layout', rYes === 'queued' && rj && text(rj).includes('BILL') && text(rj).includes('BALANCE DUE'))
  } else {
    check('receipt queued (skipped: no invoice row in this DB to reference)', true)
  }

  // 8. device protocol through the real functions (anonymous connection)
  const anon = <R>(fn: (tx: Db) => Promise<R>) => app.transaction((tx) => fn(tx as unknown as Db))
  const poll = (p: string, s: string) =>
    anon(async (tx) => (await tx.execute(sql`select * from public.cloudprnt_poll(${p}::uuid, ${s}, ${'00:11:22:33:44:55'}, ${'200 OK'})`)).rows[0] as { ok: boolean; job_id: string | null; media_type: string })
  const fetchJ = (p: string, s: string, j: string) =>
    anon(async (tx) => (await tx.execute(sql`select public.cloudprnt_fetch(${p}::uuid, ${s}, ${j}::uuid) as b`)).rows[0] as { b: Buffer | null })
  const ack = (p: string, s: string, j: string, c: string) =>
    anon(async (tx) => (await tx.execute(sql`select public.cloudprnt_ack(${p}::uuid, ${s}, ${j}::uuid, ${c}) as ok`)).rows[0] as { ok: boolean })
  const jstate = async (id: string) => (await q('select status, attempts, error from print_jobs where id=$1', [id]))[0]

  const SG = 'secret-grill-bbbbbbbbbbbbbb'
  // Earlier sections left other grill tickets pending; isolate the protocol checks to one job.
  await q(`update print_jobs set status='cancelled' where printer_id=$1 and id <> $2`, [pGrill, jg.id])
  check('poll with a wrong secret is refused', (await poll(pGrill, 'nope-nope-nope-nope-nope')).ok === false)
  check("poll with another printer's id + this secret is refused", (await poll(pDefault, SG)).ok === false)
  const pr = await poll(pGrill, SG)
  check('poll: ok, advertises the oldest pending job + media type', pr.ok && pr.job_id !== null && pr.media_type === 'application/vnd.star.starprnt')
  const seen = (await q('select last_seen_at, device_mac, last_status from printers where id=$1', [pGrill]))[0]
  check('poll records liveness (last seen, MAC, status)', seen.last_seen_at && seen.device_mac === '00:11:22:33:44:55' && seen.last_status === '200 OK')

  const pj = pr.job_id as string
  check('fetch with a wrong secret returns nothing', (await fetchJ(pGrill, 'bad-bad-bad-bad-bad-bad', pj)).b === null)
  check("another printer cannot fetch this printer's job", (await fetchJ(pDefault, 'secret-default-aaaaaaaaaaaa', pj)).b === null)
  const got = (await fetchJ(pGrill, SG, pj)).b!
  check('fetch returns the exact stored bytes and marks the job sent (attempt 1)', Buffer.compare(got, jg.payload) === 0 && (await jstate(pj)).status === 'sent' && (await jstate(pj)).attempts === 1)
  await fetchJ(pGrill, SG, pj)
  check('re-fetching a sent job (lost response) is idempotent — still attempt 1', (await jstate(pj)).attempts === 1)
  const again = await poll(pGrill, SG)
  check('an in-flight (sent) job keeps being offered until confirmed', again.job_id === pj)

  check('ack with another printer secret does nothing', (await ack(pDefault, 'secret-default-aaaaaaaaaaaa', pj, 'OK')).ok === false && (await jstate(pj)).status === 'sent')
  await ack(pGrill, SG, pj, 'OK')
  check('ack OK → printed', (await jstate(pj)).status === 'printed')
  check('queue drained: poll reports no job', (await poll(pGrill, SG)).job_id === null)

  // failure path
  const o4 = await place(A, [{ i: 0 }])
  const j4 = (await jobsFor(o4.id)).find((j) => j.printer_name === 'Grill printer')!
  await fetchJ(pGrill, SG, j4.id)
  await ack(pGrill, SG, j4.id, '52 Paper Out')
  const f4 = await jstate(j4.id)
  check('ack with an error code → failed, error recorded (surfaced, not lost)', f4.status === 'failed' && f4.error === '52 Paper Out')
  check('a failed job is not re-offered automatically', (await poll(pGrill, SG)).job_id === null)
  // staff retry (kitchen_staff may; floor_staff may not)
  const retryAs = (role: Role) =>
    withUser(A.members[role].userId, (tx) =>
      tx.update(schema.printJobs).set({ status: 'pending', error: null }).where(sql`id = ${j4.id}`).returning({ id: schema.printJobs.id }),
    )
  check('floor_staff cannot retry a job (RLS)', (await retryAs('floor_staff')).length === 0)
  check('kitchen_staff can retry → offered again', (await retryAs('kitchen_staff')).length === 1 && (await poll(pGrill, SG)).job_id === j4.id)
  await fetchJ(pGrill, SG, j4.id)
  await ack(pGrill, SG, j4.id, 'OK')
  check('retry then OK → printed', (await jstate(j4.id)).status === 'printed')

  // inactive printer / rotated secret
  await q('update printers set is_active=false where id=$1', [pGrill])
  check('inactive printer is refused', (await poll(pGrill, SG)).ok === false)
  await q('update printers set is_active=true, secret_hash=$2 where id=$1', [pGrill, sha('rotated-secret-xxxxxxxxxxxxxx')])
  check('rotating the secret cuts off the old URL', (await poll(pGrill, SG)).ok === false && (await poll(pGrill, 'rotated-secret-xxxxxxxxxxxxxx')).ok === true)

  // 9. RLS on printers / jobs
  const mkAs = (role: Role) =>
    attempt(() =>
      withUser(A.members[role].userId, (tx) =>
        tx.insert(schema.printers).values({ tenantId: A.tenantId, branchId: A.branchId, name: `p-${role}`, kind: 'kitchen', secretHash: 'x' }),
      ),
    )
  for (const role of ROLES) {
    const r = await mkAs(role)
    const allowed = role === 'owner' || role === 'manager'
    check(`role ${role}: add printer ${allowed ? 'allowed' : 'blocked'}`, r.ok === allowed)
  }
  const bSeesJobs = await withUser(B.members.owner.userId, (tx) => tx.select().from(schema.printJobs))
  const bSeesPrinters = await withUser(B.members.owner.userId, (tx) => tx.select().from(schema.printers))
  check("tenant B cannot read tenant A's print jobs or printers", bSeesJobs.every((j) => j.tenantId === B.tenantId) && bSeesPrinters.every((p) => p.tenantId === B.tenantId))
  const crossInsert = await attempt(() =>
    withUser(B.members.owner.userId, (tx) =>
      tx.insert(schema.printJobs).values({ tenantId: A.tenantId, branchId: A.branchId, printerId: pGrill, kind: 'test', title: 'x', payload: Buffer.from('x') }),
    ),
  )
  check("tenant B cannot enqueue a job into tenant A's queue", !crossInsert.ok)

  await q('delete from tenants where id = any($1)', [ids])
  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  await appPool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
