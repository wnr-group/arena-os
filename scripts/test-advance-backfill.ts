/**
 * M30 #6 — migration 0107's live-data backfill, run against a fixture of
 * pre-existing M26 data (advance_paid / advance_applied set directly, as the
 * shipped feature left them).
 *
 * The backfill INSERT is read straight out of db/migrations/0107_*.sql — the
 * very statement that ran against the real data — and only narrowed to the
 * fixture tenant, so this tests the real SQL, not a copy of it. Fixture rows
 * are created in their own tenant and deleted afterwards.
 *
 *   npx tsx scripts/test-advance-backfill.ts
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  // ── pull the real backfill statement out of the migration ────────────────
  const migration = readFileSync('db/migrations/0107_advance_payments_ledger.sql', 'utf8')
  const start = migration.indexOf('insert into public.advance_payments')
  const end = migration.indexOf(';', start)
  if (start < 0 || end < 0) throw new Error('could not find the backfill statement in 0107')
  const backfill = migration.slice(start, end)
  const filter = 'where b.advance_paid > 0'
  if (!backfill.includes(filter)) throw new Error('backfill statement changed shape — update this test')
  const scoped = backfill.replace(filter, `${filter} and b.tenant_id = $1`)

  // ── fixture tenant ───────────────────────────────────────────────────────
  const slug = 'testadvbackfill'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`],
  )
  const tenantId = t.rows[0].id
  await owner.query('delete from invoices where tenant_id=$1', [tenantId])
  await owner.query('delete from bookings where tenant_id=$1', [tenantId]) // cascades advance_payments
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id

  let n = 0
  async function booking(advancePaid: string, applied: boolean) {
    const r = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total,advance_paid,advance_applied)
       values ($1,$2,$3,'confirmed','0','0',$4,$5) returning id`,
      [tenantId, branchId, `BF-${++n}`, advancePaid, applied],
    )
    return r.rows[0].id
  }
  async function invoice(bookingId: string, status: string, issuedAt: string | null) {
    const r = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,status,issued_at)
       values ($1,$2,$3,$4,$5::invoice_status,$6) returning id`,
      [tenantId, branchId, `BF-INV-${++n}`, bookingId, status, issuedAt],
    )
    return r.rows[0].id
  }

  const unapplied = await booking('300.00', false) // advance recorded, never billed
  const applied = await booking('500.00', true) // folded into a live invoice
  const appliedInv = await invoice(applied, 'paid', '2026-09-01T10:00:00Z')
  const zero = await booking('0.00', false) // nothing collected — must be untouched
  const voidOnly = await booking('250.00', true) // applied, but its only invoice was voided
  const voidOnlyInv = await invoice(voidOnly, 'void', '2026-09-02T10:00:00Z')
  const reBilled = await booking('400.00', true) // voided invoice, then a live re-bill
  await invoice(reBilled, 'void', '2026-09-03T10:00:00Z')
  const reBilledLive = await invoice(reBilled, 'issued', '2026-09-04T10:00:00Z')
  const decimals = await booking('1234.50', false)

  const eligible = 5 // unapplied, applied, voidOnly, reBilled, decimals
  const ledger = async (id: string) =>
    (await owner.query(`select method, amount::text amount, invoice_id, collected_by from advance_payments where booking_id=$1`, [id])).rows

  // ── run the real backfill ────────────────────────────────────────────────
  const first = await owner.query(scoped, [tenantId])
  check(`one ledger row per booking with advance_paid > 0 (${eligible})`, first.rowCount === eligible)
  check(
    'row count parity: count(advance_paid > 0) = count(advance_payments)',
    (await owner.query(`select count(*)::int n from bookings where tenant_id=$1 and advance_paid>0`, [tenantId])).rows[0].n ===
      (await owner.query(`select count(*)::int n from advance_payments where tenant_id=$1`, [tenantId])).rows[0].n,
  )
  check(
    'sum parity: SUM(advance_paid) = SUM(ledger amount)',
    (await owner.query(`select (select sum(advance_paid) from bookings where tenant_id=$1)::text a, (select sum(amount) from advance_payments where tenant_id=$1)::text b`, [tenantId])).rows.every(
      (r) => r.a === r.b,
    ),
  )

  const u = await ledger(unapplied)
  check('not applied → one cash row, ₹300, invoice_id null (unconsumed)', u.length === 1 && u[0].method === 'cash' && u[0].amount === '300.00' && u[0].invoice_id === null)
  const a = await ledger(applied)
  check('applied → one cash row, ₹500, carrying that booking’s invoice id', a.length === 1 && a[0].method === 'cash' && a[0].amount === '500.00' && a[0].invoice_id === appliedInv)
  check('advance_paid = 0 → no ledger row at all', (await ledger(zero)).length === 0)
  const v = await ledger(voidOnly)
  check('applied with only a voided invoice → still stamped (never reads as unconsumed → no double-apply)', v.length === 1 && v[0].invoice_id === voidOnlyInv)
  const rb = await ledger(reBilled)
  check('applied, voided then re-billed → carries the LIVE invoice, not the voided one', rb.length === 1 && rb[0].invoice_id === reBilledLive)
  check('2dp amounts survive exactly (₹1234.50)', (await ledger(decimals))[0].amount === '1234.50')
  check('collected_by is null — the old data has no per-cashier attribution', [u, a, v, rb].every((rows) => rows[0].collected_by === null))
  check('every backfilled row carries the booking’s own tenant and branch', (await owner.query(`select 1 from advance_payments ap join bookings bk on bk.id=ap.booking_id where ap.tenant_id=$1 and (ap.branch_id<>bk.branch_id or ap.tenant_id<>bk.tenant_id)`, [tenantId])).rowCount === 0)

  // ── idempotent: a re-run adds nothing ────────────────────────────────────
  const second = await owner.query(scoped, [tenantId])
  check('re-running the backfill inserts nothing (no duplicate rows)', second.rowCount === 0)
  check('…and the ledger is unchanged', (await owner.query(`select count(*)::int n from advance_payments where tenant_id=$1`, [tenantId])).rows[0].n === eligible)

  // ── the old columns are left exactly as they were (additive-only) ────────
  const old = await owner.query(`select advance_paid::text p, advance_applied a from bookings where id=$1`, [applied])
  check('bookings.advance_paid / advance_applied are untouched by the backfill', old.rows[0].p === '500.00' && old.rows[0].a === true)

  // cleanup
  await owner.query('delete from invoices where tenant_id=$1', [tenantId])
  await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
