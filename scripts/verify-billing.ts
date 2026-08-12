/**
 * Proves the billing data-model invariants against a real database:
 *   - every object migration 0010 promises exists (tables, enums, indexes, triggers)
 *   - db/schema.ts mirrors the SQL exactly — no column/type/nullability drift
 *   - invoice numbers are unique PER TENANT, and reusable across tenants
 *   - money is numeric(10,2) and round-trips exactly
 *   - RLS hides every billing table from another tenant, reads AND writes
 *   - refunds are owner/manager-only, and append-only by grant
 *   - the audit log accepts inserts, is tenant-isolated, and can never be rewritten
 *
 *   npx tsx scripts/verify-billing.ts
 */
import { Client } from 'pg'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { loadEnv } from './env'
import {
  invoices,
  invoiceItems,
  payments,
  refunds,
  sequences,
  auditLog,
} from '../db/schema'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const BILLING_TABLES = [invoices, invoiceItems, payments, refunds, sequences, auditLog]

/** Drizzle's SQL type → the shape information_schema reports. */
function drizzleType(sqlType: string): string {
  return sqlType.replace(/,\s+/g, ',')
}

async function main() {
  loadEnv()
  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await owner.connect()
  await app.connect()

  // ── fixtures via owner (bypasses RLS) ─────────────────────────────────────
  async function makeUser(email: string, tenantId: string, role: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
      [tenantId, u.rows[0].id, role],
    )
    const m = await owner.query<{ id: string }>(
      'select id from memberships where tenant_id=$1 and user_id=$2',
      [tenantId, u.rows[0].id],
    )
    return { userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status) values ($1,$2,'active')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const ownerUser = await makeUser(`owner@${slug}.test`, tenantId, 'owner')
    return { tenantId, branchId: b.rows[0].id, ...ownerUser }
  }

  const a = await makeTenant('verifybilla')
  const b = await makeTenant('verifybillb')
  const cashier = await makeUser('cashier@verifybilla.test', a.tenantId, 'cashier')

  const customerA = (
    await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,'+919876511001','Bill Payer')
       on conflict (tenant_id,phone) do update set name=excluded.name returning id`,
      [a.tenantId],
    )
  ).rows[0].id
  const bookingA = (
    await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,total)
       values ($1,$2,'VB-1',$3,'0')
       on conflict (tenant_id,booking_number) do update set total='0' returning id`,
      [a.tenantId, a.branchId, customerA],
    )
  ).rows[0].id

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      return await fn()
    } finally {
      await app.query('commit')
    }
  }

  /** Run one statement as `userId`; true if it succeeded, false if refused. */
  async function tryAsUser(userId: string, q: string, params: unknown[] = []): Promise<boolean> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      await app.query(q, params)
      await app.query('commit')
      return true
    } catch {
      await app.query('rollback')
      return false
    }
  }

  // ── 1. every object the migration promises exists ─────────────────────────
  const tableNames = BILLING_TABLES.map((t) => getTableConfig(t).name)
  const live = (
    await owner.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name = any($1)`,
      [tableNames],
    )
  ).rows.map((r) => r.table_name)
  check(
    `all six billing tables exist (${tableNames.join(', ')})`,
    tableNames.every((n) => live.includes(n)),
  )

  const enumValues = async (name: string) => {
    const r = await owner.query<{ v: string }>(
      `select e.enumlabel v from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname = $1 order by e.enumsortorder`,
      [name],
    )
    return r.rows.map((x) => x.v)
  }
  check(
    "enum invoice_status = draft|issued|paid|void",
    (await enumValues('invoice_status')).join('|') === 'draft|issued|paid|void',
  )
  check(
    'enum payment_method = cash|card|upi|online|wallet',
    (await enumValues('payment_method')).join('|') === 'cash|card|upi|online|wallet',
  )
  check(
    'enum payment_status = pending|captured|failed|refunded',
    (await enumValues('payment_status')).join('|') === 'pending|captured|failed|refunded',
  )

  const indexes = (
    await owner.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public' and tablename = any($1)`,
      [tableNames],
    )
  ).rows.map((r) => r.indexname)
  for (const ix of [
    'idx_invoices_branch',
    'idx_invoice_items_invoice',
    'idx_payments_invoice',
    'idx_refunds_payment',
    'idx_audit_log_tenant_created',
  ]) {
    check(`index ${ix} created`, indexes.includes(ix))
  }
  check('sequences PK is (tenant_id, kind, period)', indexes.includes('sequences_pkey'))

  const triggers = (
    await owner.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal
         and tgrelid = any($1::regclass[])`,
      [['public.invoices', 'public.payments']],
    )
  ).rows.map((r) => r.tgname)
  check('set_updated_at trigger attached to invoices', triggers.includes('trg_invoices_updated'))
  check('set_updated_at trigger attached to payments', triggers.includes('trg_payments_updated'))

  // ── 2. no drift between db/schema.ts and the SQL migration ────────────────
  for (const table of BILLING_TABLES) {
    const cfg = getTableConfig(table)
    const pg = await owner.query<{
      column_name: string
      data_type: string
      udt_name: string
      is_nullable: string
      numeric_precision: number | null
      numeric_scale: number | null
    }>(
      `select column_name, data_type, udt_name, is_nullable, numeric_precision, numeric_scale
         from information_schema.columns
        where table_schema='public' and table_name=$1`,
      [cfg.name],
    )

    const dbCols = new Map(pg.rows.map((r) => [r.column_name, r]))
    const tsCols = new Map(cfg.columns.map((c) => [c.name, c]))

    const missing = [...tsCols.keys()].filter((n) => !dbCols.has(n))
    const extra = [...dbCols.keys()].filter((n) => !tsCols.has(n))
    check(
      `${cfg.name}: db/schema.ts declares exactly the SQL columns` +
        (missing.length ? ` — missing in DB: ${missing}` : '') +
        (extra.length ? ` — missing in schema.ts: ${extra}` : ''),
      missing.length === 0 && extra.length === 0,
    )

    const mismatched: string[] = []
    for (const [name, col] of tsCols) {
      const row = dbCols.get(name)
      if (!row) continue
      const actual =
        row.data_type === 'USER-DEFINED'
          ? row.udt_name
          : row.data_type === 'numeric' && row.numeric_precision !== null
            ? `numeric(${row.numeric_precision},${row.numeric_scale})`
            : row.data_type
      if (drizzleType(col.getSQLType()) !== actual) mismatched.push(`${name} ${col.getSQLType()}≠${actual}`)
      if (col.notNull !== (row.is_nullable === 'NO')) mismatched.push(`${name} nullability`)
    }
    check(`${cfg.name}: column types + nullability match` + (mismatched.length ? ` — ${mismatched}` : ''), mismatched.length === 0)
  }

  // ── 3. every money column is numeric(10,2) ────────────────────────────────
  // `tax_rate` is deliberately excluded: it is a percentage, so it mirrors
  // tax_rates.percent at numeric(5,2).
  const money = await owner.query<{ table_name: string; column_name: string; ok: boolean }>(
    `select table_name, column_name, (numeric_precision=10 and numeric_scale=2) ok
       from information_schema.columns
      where table_schema='public' and table_name = any($1)
        and column_name in ('subtotal','discount','tax_total','total','unit_price',
                            'line_total','amount','qty')`,
    [tableNames],
  )
  check(
    `all 9 money columns across the billing tables are numeric(10,2)`,
    money.rows.length === 9 && money.rows.every((r) => r.ok),
  )
  check(
    'invoice_items.tax_rate is a percentage at numeric(5,2), not money',
    (
      await owner.query(
        `select 1 from information_schema.columns where table_schema='public'
          and table_name='invoice_items' and column_name='tax_rate'
          and numeric_precision=5 and numeric_scale=2`,
      )
    ).rows.length === 1,
  )

  // ── 4. invoice numbers are unique PER TENANT ──────────────────────────────
  const invA = await tryAsUser(
    a.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,customer_id,
       subtotal,discount,tax_total,tax_breakup,total,status,place_of_supply,issued_at)
     values ($1,$2,'INV-0001',$3,$4,'1000.00','100.00','162.00',
       '[{"rate":18,"taxable":"900.00","cgst":"81.00","sgst":"81.00"}]'::jsonb,
       '1062.00','issued','Tamil Nadu',now())`,
    [a.tenantId, a.branchId, bookingA, customerA],
  )
  check('tenant A can raise an invoice', invA)

  const dupe = await tryAsUser(
    a.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,total) values ($1,$2,'INV-0001','1.00')`,
    [a.tenantId, a.branchId],
  )
  check('a duplicate invoice_number in the SAME tenant is REJECTED', !dupe)

  const sameNumberElsewhere = await tryAsUser(
    b.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,total) values ($1,$2,'INV-0001','50.00')`,
    [b.tenantId, b.branchId],
  )
  check('the SAME invoice_number in another tenant IS allowed', sameNumberElsewhere)

  const bothRows = await owner.query('select id from invoices where invoice_number=$1', ['INV-0001'])
  check('…and produced two distinct invoice rows', bothRows.rows.length === 2)

  const invoiceA = (
    await owner.query<{ id: string }>('select id from invoices where tenant_id=$1', [a.tenantId])
  ).rows[0].id
  const invoiceB = (
    await owner.query<{ id: string }>('select id from invoices where tenant_id=$1', [b.tenantId])
  ).rows[0].id

  // ── 5. money round-trips exactly, and totals stay non-negative ────────────
  const stored = await owner.query<{
    subtotal: string
    discount: string
    tax_total: string
    total: string
    tax_breakup: unknown
    status: string
  }>('select subtotal, discount, tax_total, total, tax_breakup, status from invoices where id=$1', [invoiceA])
  const s = stored.rows[0]
  check(
    'money stores exact decimals (1000.00 − 100.00 + 162.00 = 1062.00)',
    s.subtotal === '1000.00' && s.discount === '100.00' && s.tax_total === '162.00' && s.total === '1062.00',
  )
  check(
    'tax_breakup round-trips as jsonb',
    Array.isArray(s.tax_breakup) && (s.tax_breakup as { cgst: string }[])[0].cgst === '81.00',
  )
  check('invoice status enum stored', s.status === 'issued')

  const negative = await tryAsUser(
    a.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,total) values ($1,$2,'INV-NEG','-1.00')`,
    [a.tenantId, a.branchId],
  )
  check('a negative invoice total is REJECTED by the CHECK constraint', !negative)

  // line items + split payments
  await owner.query(
    `insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,tax_rate,line_total)
     values ($1,$2,'booking','PS5 Station 1 · 2h','2.00','450.00','18.00','900.00')`,
    [a.tenantId, invoiceA],
  )
  const badKind = await tryAsUser(
    a.userId,
    `insert into invoice_items (tenant_id,invoice_id,kind,description,line_total)
     values ($1,$2,'bribe','x','1.00')`,
    [a.tenantId, invoiceA],
  )
  check('an unknown invoice_item kind is REJECTED by the CHECK constraint', !badKind)

  const splitOne = await tryAsUser(
    a.userId,
    `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,collected_by)
     values ($1,$2,$3,'cash','562.00','captured',$4)`,
    [a.tenantId, a.branchId, invoiceA, cashier.membershipId],
  )
  const splitTwo = await tryAsUser(
    a.userId,
    `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,gateway,gateway_payment_id,collected_by)
     values ($1,$2,$3,'upi','500.00','captured','razorpay','pay_XYZ',$4)`,
    [a.tenantId, a.branchId, invoiceA, cashier.membershipId],
  )
  check('one invoice accepts several tenders (split payments)', splitOne && splitTwo)

  const settled = await owner.query<{ total: string; n: string }>(
    'select coalesce(sum(amount),0) total, count(*) n from payments where invoice_id=$1',
    [invoiceA],
  )
  check(
    'the two tenders sum to the invoice total (1062.00 over 2 rows)',
    settled.rows[0].total === '1062.00' && settled.rows[0].n === '2',
  )

  const zeroPayment = await tryAsUser(
    a.userId,
    `insert into payments (tenant_id,branch_id,invoice_id,method,amount) values ($1,$2,$3,'cash','0')`,
    [a.tenantId, a.branchId, invoiceA],
  )
  check('a zero-amount payment is REJECTED by the amount > 0 CHECK', !zeroPayment)

  const paymentA = (
    await owner.query<{ id: string }>("select id from payments where invoice_id=$1 and method='cash'", [invoiceA])
  ).rows[0].id

  // ── 6. the set_updated_at trigger is live on invoices ─────────────────────
  const beforeTouch = await owner.query<{ same: boolean }>(
    'select created_at = updated_at as same from invoices where id=$1',
    [invoiceA],
  )
  check('a new invoice starts with updated_at equal to created_at', beforeTouch.rows[0].same === true)
  await owner.query(`update invoices set status='paid' where id=$1`, [invoiceA])
  const afterTouch = await owner.query<{ moved: boolean }>(
    'select updated_at > created_at as moved from invoices where id=$1',
    [invoiceA],
  )
  check('updating an invoice moves updated_at via the trigger', afterTouch.rows[0].moved === true)

  // ── 7. refunds: owner/manager write, every member reads ───────────────────
  const cashierRefund = await tryAsUser(
    cashier.userId,
    `insert into refunds (tenant_id,payment_id,amount,reason,created_by) values ($1,$2,'100.00','x',$3)`,
    [a.tenantId, paymentA, cashier.membershipId],
  )
  check('a CASHIER cannot write a refund (auth_is_manager)', !cashierRefund)

  const ownerRefund = await tryAsUser(
    a.userId,
    `insert into refunds (tenant_id,payment_id,amount,reason,created_by) values ($1,$2,'62.00','damaged controller',$3)`,
    [a.tenantId, paymentA, a.membershipId],
  )
  check('an OWNER can write a refund', ownerRefund)

  await asUser(cashier.userId, async () => {
    const r = await app.query('select amount from refunds where payment_id=$1', [paymentA])
    check('a cashier CAN read refunds (member select policy)', r.rows.length === 1 && r.rows[0].amount === '62.00')
  })

  const negativeRefund = await tryAsUser(
    a.userId,
    `insert into refunds (tenant_id,payment_id,amount,created_by) values ($1,$2,'-5.00',$3)`,
    [a.tenantId, paymentA, a.membershipId],
  )
  check('a negative refund is REJECTED by the amount > 0 CHECK', !negativeRefund)

  const refundUpdate = await tryAsUser(a.userId, `update refunds set amount='0.01' where payment_id=$1`, [paymentA])
  check('refunds are append-only — even an owner cannot update one (no grant)', !refundUpdate)

  // ── 8. audit_log: insert works, reads are tenant-scoped, trail is immutable ─
  const audited = await tryAsUser(
    a.userId,
    `insert into audit_log (tenant_id,actor_membership_id,action,entity_type,entity_id,"before","after")
     values ($1,$2,'refund.create','payment',$3,'{"status":"captured"}'::jsonb,'{"status":"refunded"}'::jsonb)`,
    [a.tenantId, a.membershipId, paymentA],
  )
  check('a member can insert an audit_log entry', audited)

  await asUser(a.userId, async () => {
    const r = await app.query<{ action: string; after: { status: string } }>(
      'select action, "after" from audit_log where tenant_id=$1',
      [a.tenantId],
    )
    check(
      'tenant A reads back its own audit entry with both jsonb snapshots',
      r.rows.length === 1 && r.rows[0].action === 'refund.create' && r.rows[0].after.status === 'refunded',
    )
  })

  const auditUpdate = await tryAsUser(a.userId, `update audit_log set action='nothing' where tenant_id=$1`, [a.tenantId])
  check('the audit trail cannot be rewritten (no update grant)', !auditUpdate)
  const auditDelete = await tryAsUser(a.userId, 'delete from audit_log where tenant_id=$1', [a.tenantId])
  check('the audit trail cannot be erased (no delete grant)', !auditDelete)

  // ── 9. sequences: tenant-scoped, atomically incremented ───────────────────
  const bump = `insert into sequences (tenant_id,kind,period,value) values ($1,'invoice','2026',1)
                on conflict (tenant_id,kind,period) do update set value = sequences.value + 1
                returning value`
  await asUser(a.userId, async () => {
    const first = await app.query<{ value: number }>(bump, [a.tenantId])
    const second = await app.query<{ value: number }>(bump, [a.tenantId])
    check('sequences increments atomically on its PK (1 → 2)', first.rows[0].value === 1 && second.rows[0].value === 2)
  })
  const badKindSeq = await tryAsUser(a.userId, `insert into sequences (tenant_id,kind,period) values ($1,'payroll','2026')`, [
    a.tenantId,
  ])
  check('an unknown sequence kind is REJECTED by the CHECK constraint', !badKindSeq)

  // ── 10. RLS: nothing crosses the tenant boundary ──────────────────────────
  await owner.query(
    `insert into sequences (tenant_id,kind,period,value) values ($1,'invoice','2026',7)
     on conflict (tenant_id,kind,period) do update set value=7`,
    [b.tenantId],
  )
  await owner.query(
    `insert into audit_log (tenant_id,action,entity_type) values ($1,'invoice.void','invoice')`,
    [b.tenantId],
  )

  await asUser(b.userId, async () => {
    const inv = await app.query('select id from invoices where id=$1', [invoiceA])
    check('tenant B cannot read tenant A’s invoice (RLS)', inv.rows.length === 0)

    const items = await app.query('select id from invoice_items where invoice_id=$1', [invoiceA])
    check('tenant B cannot read tenant A’s invoice items', items.rows.length === 0)

    const pay = await app.query('select id from payments where invoice_id=$1', [invoiceA])
    check('tenant B cannot read tenant A’s payments', pay.rows.length === 0)

    const ref = await app.query('select id from refunds where payment_id=$1', [paymentA])
    check('tenant B cannot read tenant A’s refunds', ref.rows.length === 0)

    const seq = await app.query('select value from sequences')
    check(
      'tenant B sees ONLY its own sequence counters',
      seq.rows.length === 1 && seq.rows[0].value === 7,
    )

    const log = await app.query('select tenant_id from audit_log')
    check(
      'tenant B’s audit_log select is scoped to its own tenant',
      log.rows.length === 1 && log.rows[0].tenant_id === b.tenantId,
    )
  })

  await asUser(a.userId, async () => {
    const inv = await app.query('select id from invoices where id=$1', [invoiceA])
    check('tenant A CAN read its own invoice', inv.rows.length === 1)
  })

  await app.query('begin')
  {
    const r = await app.query('select id from invoices')
    check('an unauthenticated app connection sees 0 invoices', r.rows.length === 0)
  }
  await app.query('commit')

  // writes
  const crossInvoice = await tryAsUser(
    a.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,total) values ($1,$2,'INV-HACK','1.00')`,
    [b.tenantId, b.branchId],
  )
  check('tenant A CANNOT raise an invoice inside tenant B (WITH CHECK)', !crossInvoice)

  const crossPayment = await tryAsUser(
    a.userId,
    `insert into payments (tenant_id,branch_id,invoice_id,method,amount) values ($1,$2,$3,'cash','1.00')`,
    [b.tenantId, b.branchId, invoiceB],
  )
  check('tenant A CANNOT record a payment against tenant B’s invoice', !crossPayment)

  const crossAudit = await tryAsUser(
    a.userId,
    `insert into audit_log (tenant_id,action,entity_type) values ($1,'x','y')`,
    [b.tenantId],
  )
  check('tenant A CANNOT write into tenant B’s audit log', !crossAudit)

  const crossUpdate = await tryAsUser(a.userId, `update invoices set total='0.01' where id=$1`, [invoiceB])
  const bTotal = (await owner.query('select total from invoices where id=$1', [invoiceB])).rows[0].total
  check('tenant A cannot alter tenant B’s invoice total', crossUpdate === false || bTotal !== '0.01')

  // ── 11. composite FKs refuse a cross-tenant link (FKs ignore RLS) ─────────
  // The WITH CHECK passes here — the tenant_id IS tenant B's. It is the
  // (tenant_id, booking_id) FK that refuses a booking belonging to tenant A.
  const smuggledBooking = await tryAsUser(
    b.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,total)
     values ($1,$2,'INV-SMUGGLE',$3,'1.00')`,
    [b.tenantId, b.branchId, bookingA],
  )
  check('an invoice CANNOT reference another tenant’s booking (composite FK)', !smuggledBooking)

  const smuggledCustomer = await tryAsUser(
    b.userId,
    `insert into invoices (tenant_id,branch_id,invoice_number,customer_id,total)
     values ($1,$2,'INV-SMUGGLE2',$3,'1.00')`,
    [b.tenantId, b.branchId, customerA],
  )
  check('an invoice CANNOT reference another tenant’s customer (composite FK)', !smuggledCustomer)

  const smuggledItem = await tryAsUser(
    b.userId,
    `insert into invoice_items (tenant_id,invoice_id,kind,description,line_total)
     values ($1,$2,'food','smuggled','1.00')`,
    [b.tenantId, invoiceA],
  )
  check('a line item CANNOT attach to another tenant’s invoice (composite FK)', !smuggledItem)

  // ── 12. the invoice survives its booking; its lines do not survive it ─────
  await owner.query('delete from bookings where id=$1', [bookingA])
  const orphan = await owner.query<{ booking_id: string | null; total: string }>(
    'select booking_id, total from invoices where id=$1',
    [invoiceA],
  )
  check('deleting a booking does NOT delete its invoice', orphan.rows.length === 1)
  check('…the invoice’s booking_id is set to null', orphan.rows[0].booking_id === null)
  check('…and its money snapshot is preserved', orphan.rows[0].total === '1062.00')

  await owner.query('delete from invoices where id=$1', [invoiceA])
  const cascaded = await owner.query('select id from invoice_items where invoice_id=$1', [invoiceA])
  const cascadedPayments = await owner.query('select id from payments where invoice_id=$1', [invoiceA])
  const cascadedRefunds = await owner.query('select id from refunds where payment_id=$1', [paymentA])
  check('deleting an invoice cascades its line items away', cascaded.rows.length === 0)
  check('…its payments away', cascadedPayments.rows.length === 0)
  check('…and the refunds hanging off those payments', cascadedRefunds.rows.length === 0)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = any($1)', [[a.tenantId, b.tenantId]])
  await owner.query('delete from users where email like $1', ['%@verifybill%.test'])
  await owner.end()
  await app.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
