/**
 * Kitchen printing for orders no staff member places, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-printing-online.ts
 *
 *  - An auto-accepted online order prints (system context, after commit), once.
 *  - A pay-now order confirmed by the webhook prints.
 *  - A failing enqueue never fails or rolls back the order or the webhook.
 *  - No printer configured: no job, no error.
 *  - module.printing lost: no job is queued.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { randomUUID } from 'node:crypto'
import * as schema from '../db/schema'
import { createOrderCore } from '../lib/orders/service'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

type Db = NodePgDatabase<typeof schema>
let pass = 0,
  fail = 0
const check = (l: string, c: boolean, detail?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else {
    fail++
    if (detail !== undefined) console.log('        got:', detail)
  }
}
const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so these must load after loadEnv().
  const { printAcceptedOnlineOrder } = await import('../lib/printing/system')
  const { applyVerifiedPaymentWebhook } = await import('../lib/payments/webhook')
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const owner = drizzle(ownerPool, { schema })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows
  const RUN = randomUUID().slice(0, 8)

  const slug = 'testprintonline'
  const t = await q(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'restaurant')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t[0].id as string
  await entitleTenant(ownerPool, tenantId)
  const b = await q(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b[0].id as string
  const u = await q(
    `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const m = await q(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, u[0].id],
  )
  const membershipId = m[0].id as string
  const cat = await q(
    `insert into menu_categories (tenant_id,name) values ($1,'Mains') on conflict (tenant_id,name) do update set name=excluded.name returning id`,
    [tenantId],
  )
  const item = (await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Burger','200') returning id`, [tenantId, cat[0].id]))[0].id as string

  await q('delete from orders where tenant_id=$1', [tenantId])
  await q('delete from printers where tenant_id=$1', [tenantId])
  await q('delete from payment_intents where tenant_id=$1', [tenantId])

  const place = async (acceptanceStatus: 'accepted' | 'awaiting_payment', member: string | null = null) => {
    const o = await owner.transaction((tx) =>
      createOrderCore(
        tx as unknown as Db,
        { tenantId, timezone: TZ, membershipId: member },
        { branchId, channel: 'online', acceptanceStatus, items: [{ menuItemId: item, qty: 1 }] },
      ),
    )
    const kotId = (await q('select id from kots where order_id=$1', [o.id]))[0].id as string
    return { orderId: o.id as string, kotId }
  }
  const jobs = async (kotId: string) => Number((await q('select count(*) c from print_jobs where kot_id=$1', [kotId]))[0].c)
  const mkPrinter = async () =>
    (
      await q(
        `insert into printers (tenant_id,branch_id,name,kind,is_default,secret_hash) values ($1,$2,'Pass','kitchen',true,'x') returning id`,
        [tenantId, branchId],
      )
    )[0].id as string

  // ── no printer configured ────────────────────────────────────────────────
  const none = await place('accepted')
  await printAcceptedOnlineOrder(tenantId, none.orderId)
  check('no printer: no job and no error', (await jobs(none.kotId)) === 0)

  // ── auto-accepted online order ────────────────────────────────────────────
  await mkPrinter()
  const auto = await place('accepted')
  check('the order itself queues nothing (no member to own a job)', (await jobs(auto.kotId)) === 0)
  await printAcceptedOnlineOrder(tenantId, auto.orderId)
  check('auto-accepted online order with a printer produces a print job', (await jobs(auto.kotId)) === 1)
  await printAcceptedOnlineOrder(tenantId, auto.orderId)
  check('a replay does not print the order twice', (await jobs(auto.kotId)) === 1)

  // ── entitlement lost ──────────────────────────────────────────────────────
  await q('delete from tenant_subscriptions where tenant_id=$1', [tenantId])
  const noPlan = await place('accepted')
  await printAcceptedOnlineOrder(tenantId, noPlan.orderId)
  const staffNoPlan = await place('accepted', membershipId)
  check('module.printing lost: online order queues no job', (await jobs(noPlan.kotId)) === 0)
  check('module.printing lost: a staff-placed order queues no job either', (await jobs(staffNoPlan.kotId)) === 0)
  await entitleTenant(ownerPool, tenantId)

  // ── pay-now order confirmed by the webhook ───────────────────────────────
  const payNow = async (tag: string) => {
    const o = await place('awaiting_payment')
    const gatewayOrder = `order_${RUN}_${tag}`
    await q(
      `insert into payment_intents (tenant_id,branch_id,order_id,purpose,gateway,gateway_order_id,amount,status)
       values ($1,$2,$3,'order_payment','razorpay',$4,200,'pending')`,
      [tenantId, branchId, o.orderId, gatewayOrder],
    )
    return { ...o, gatewayOrder }
  }
  const capture = (gatewayOrder: string, tag: string) =>
    applyVerifiedPaymentWebhook({
      verifiedTenantId: tenantId,
      eventType: 'payment.captured',
      eventId: `evt_${RUN}_${tag}`,
      payment: { id: `pay_${RUN}_${tag}`, order_id: gatewayOrder, amount: 20000, currency: 'INR', status: 'captured' } as never,
    })
  const accepted = async (orderId: string) => (await q('select acceptance_status s from orders where id=$1', [orderId]))[0].s as string

  const p1 = await payNow('ok')
  const r1 = await capture(p1.gatewayOrder, 'ok')
  check('webhook confirms the pay-now order', r1.kind === 'processed' && (await accepted(p1.orderId)) === 'accepted', r1)
  check('pay-now order confirmed by the webhook produces a print job', (await jobs(p1.kotId)) === 1)
  const again = await capture(p1.gatewayOrder, 'ok')
  check('a redelivered webhook does not print again', again.kind === 'duplicate' && (await jobs(p1.kotId)) === 1, again)

  // ── a failing enqueue never fails the order or the webhook ───────────────
  // The insert into print_jobs is made to raise for this tenant only.
  await q(`create or replace function public.tg_test_fail_print() returns trigger language plpgsql as $$ begin raise exception 'printer exploded'; end $$`)
  await q(`drop trigger if exists tg_test_fail_print on public.print_jobs`)
  await q(`create trigger tg_test_fail_print before insert on public.print_jobs for each row when (new.tenant_id = '${tenantId}') execute function public.tg_test_fail_print()`)
  try {
    const p2 = await payNow('boom')
    const r2 = await capture(p2.gatewayOrder, 'boom')
    check('failing enqueue: the webhook still succeeds', r2.kind === 'processed', r2)
    const row = (await q('select acceptance_status s, status st, invoice_id i from orders where id=$1', [p2.orderId]))[0]
    check('failing enqueue: the order is still accepted, billed and invoiced', row.s === 'accepted' && row.st === 'billed' && row.i !== null, row)
    check('failing enqueue: no job, and the payment was recorded', (await jobs(p2.kotId)) === 0 && Number((await q(`select count(*) c from payment_intents where id is not null and gateway_order_id=$1 and status='paid'`, [p2.gatewayOrder]))[0].c) === 1)

    const staff = await attempt(() => place('accepted', membershipId))
    check('failing enqueue: a staff order is still created', staff.ok && Number((await q('select count(*) c from orders where id=$1', [staff.ok ? staff.v.orderId : randomUUID()]))[0].c) === 1)

    const auto2 = await place('accepted')
    await printAcceptedOnlineOrder(tenantId, auto2.orderId) // must not throw
    check('failing enqueue: the online helper swallows it', (await jobs(auto2.kotId)) === 0)
  } finally {
    await q(`drop trigger if exists tg_test_fail_print on public.print_jobs`)
    await q(`drop function if exists public.tg_test_fail_print()`)
  }

  // ── printer deleted: no job, no error ─────────────────────────────────────
  await q('delete from printers where tenant_id=$1', [tenantId])
  const gone = await place('accepted')
  await printAcceptedOnlineOrder(tenantId, gone.orderId)
  check('printer deleted: no job and no error', (await jobs(gone.kotId)) === 0)

  await q('delete from tenants where id=$1', [tenantId])
  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  process.exit(fail ? 1 : 0)

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) }
    }
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
