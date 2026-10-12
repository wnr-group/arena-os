/**
 * M36 #1 — booking payment mode (venue / advance / full) on payment_settings.
 * Real actions behind the real requireManager guard, real non-manager DB roles.
 *
 *   migration   existing rows + tenants without a row read as optional_full
 *   validation  percent 0 / 100 / negative, fixed <= 0, advance with no value, bad mode
 *   roles       owner and manager can save; cashier/receptionist/floor_staff cannot
 *               (action AND RLS); another tenant cannot touch it
 *   credentials advance/full refused without Razorpay creds; removing the secret
 *               reverts advance/full to venue with a notice
 *   db          CHECKs reject invalid combos written straight to the table
 *   audit       who, old -> new
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-booking-payment-mode.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()
type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { saveBookingPaymentSettings, savePaymentSettings, clearRazorpaySecret } = await import('../lib/actions/payment-settings')
  const { getPaymentSettingsForClient } = await import('../lib/settings/payment-settings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })
  const tag = randomBytes(3).toString('hex')
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const asUser = <T>(userId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  async function makeTenant(slug: string) {
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$1,'active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])).rows[0].id
    return { tenantId, branchId }
  }
  async function makeUser(t: { tenantId: string; branchId: string }, role: string) {
    const u = await q<{ id: string }>(`insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`, [`pm-${role}-${t.tenantId.slice(0, 4)}-${tag}@example.test`, role])
    const m = await q<{ id: string }>(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5) returning id`, [t.tenantId, u.rows[0].id, t.branchId, role, role])
    const token = randomBytes(32).toString('hex')
    await q(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), u.rows[0].id])
    return { id: u.rows[0].id, membershipId: m.rows[0].id, token }
  }
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  const as = (u: { token: string }, slug: string) => {
    g.__ARENA_TEST_SESSION = u.token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  }
  const slugA = `pm-a-${tag}`
  const slugB = `pm-b-${tag}`
  const A = await makeTenant(slugA)
  const B = await makeTenant(slugB)
  const ownerU = await makeUser(A, 'owner')
  const mgr = await makeUser(A, 'manager')
  const others = [await makeUser(A, 'cashier'), await makeUser(A, 'receptionist'), await makeUser(A, 'floor_staff')]
  const bOwner = await makeUser(B, 'owner')
  const row = async (tenantId = A.tenantId) =>
    (await q<{ online_payment_mode: string; advance_type: string | null; advance_value: string | null }>(`select online_payment_mode, advance_type, advance_value from payment_settings where tenant_id=$1`, [tenantId])).rows[0]
  const audits = async () =>
    (await q<{ before: { mode: string }; after: { mode: string; advanceType: string | null; advanceValue: number | null }; actor_membership_id: string }>(`select before, after, actor_membership_id from audit_log where tenant_id=$1 and action='payment_settings.booking_mode_changed' order by created_at`, [A.tenantId])).rows

  console.log('\n── migration default ──')
  as(ownerU, slugA)
  const noRow = await getPaymentSettingsForClient({ user: { id: ownerU.id }, tenant: { id: A.tenantId } } as never)
  check('tenant with no payment_settings row reads as optional_full', noRow.onlinePaymentMode === 'optional_full', noRow)
  await q(`insert into payment_settings (tenant_id) values ($1)`, [A.tenantId])
  check('a row inserted without a mode lands on optional_full', (await row()).online_payment_mode === 'optional_full', await row())

  console.log('\n── credentials gate ──')
  for (const mode of ['full', 'advance'] as const) {
    const r = await saveBookingPaymentSettings({ mode, advanceType: 'fixed', advanceValue: 500 })
    check(`${mode} refused without Razorpay credentials`, Boolean(r.error) && /Razorpay/.test(r.error!), r)
  }
  check('…and nothing was stored', (await row()).online_payment_mode === 'optional_full')
  const rawFull = await owner.query(`update payment_settings set online_payment_mode='full' where tenant_id=$1`, [A.tenantId]).then(() => 'ok', (e) => String(e.code))
  check('the DB CHECK also refuses full with no credentials (23514)', rawFull === '23514', rawFull)

  const creds = await savePaymentSettings({ razorpayKeyId: 'rzp_test_abc123', razorpayKeySecret: 'secret-value-123' })
  check('manager saves Razorpay credentials', !creds.error, creds)

  console.log('\n── validation ──')
  const bad: [string, Parameters<typeof saveBookingPaymentSettings>[0]][] = [
    ['percent 0', { mode: 'advance', advanceType: 'percent', advanceValue: 0 }],
    ['percent 100', { mode: 'advance', advanceType: 'percent', advanceValue: 100 }],
    ['percent 150', { mode: 'advance', advanceType: 'percent', advanceValue: 150 }],
    ['percent negative', { mode: 'advance', advanceType: 'percent', advanceValue: -5 }],
    ['fixed 0', { mode: 'advance', advanceType: 'fixed', advanceValue: 0 }],
    ['fixed negative', { mode: 'advance', advanceType: 'fixed', advanceValue: -10 }],
    ['advance with no value', { mode: 'advance', advanceType: 'fixed' }],
    ['advance with no type', { mode: 'advance', advanceValue: 10 }],
    ['advance with nothing', { mode: 'advance' }],
    ['NaN value', { mode: 'advance', advanceType: 'fixed', advanceValue: Number.NaN }],
    ['unknown mode', { mode: 'optional_full' as never }],
    ['mode garbage', { mode: 'free' as never }],
  ]
  for (const [label, input] of bad) {
    const r = await saveBookingPaymentSettings(input)
    check(`${label} rejected`, Boolean(r.error), r)
  }
  check('…none of the rejected calls changed the row', (await row()).online_payment_mode === 'optional_full')
  const dbBad: [string, string][] = [
    ['advance without type/value', `update payment_settings set online_payment_mode='advance' where tenant_id=$1`],
    ['percent 100 in the table', `update payment_settings set online_payment_mode='advance', advance_type='percent', advance_value=100 where tenant_id=$1`],
    ['fixed 0 in the table', `update payment_settings set online_payment_mode='advance', advance_type='fixed', advance_value=0 where tenant_id=$1`],
    ['venue with a stray advance value', `update payment_settings set online_payment_mode='venue', advance_type='fixed', advance_value=5 where tenant_id=$1`],
  ]
  for (const [label, stmt] of dbBad) {
    const code = await owner.query(stmt, [A.tenantId]).then(() => 'ok', (e) => String(e.code))
    check(`DB CHECK rejects ${label}`, code === '23514', code)
  }

  console.log('\n── valid saves + audit ──')
  as(ownerU, slugA)
  let r = await saveBookingPaymentSettings({ mode: 'advance', advanceType: 'percent', advanceValue: 25.456 })
  let rw = await row()
  check('owner saves advance 25.456% (rounded to 2dp)', !r.error && rw.online_payment_mode === 'advance' && rw.advance_type === 'percent' && Number(rw.advance_value) === 25.46, { r, rw })
  as(mgr, slugA)
  r = await saveBookingPaymentSettings({ mode: 'advance', advanceType: 'fixed', advanceValue: 500 })
  rw = await row()
  check('manager saves advance ₹500 fixed', !r.error && rw.advance_type === 'fixed' && Number(rw.advance_value) === 500, { r, rw })
  r = await saveBookingPaymentSettings({ mode: 'full', advanceType: 'fixed', advanceValue: 500 })
  rw = await row()
  check('full clears the stale advance type/value', !r.error && rw.online_payment_mode === 'full' && rw.advance_type === null && rw.advance_value === null, { r, rw })
  r = await saveBookingPaymentSettings({ mode: 'venue' })
  check('venue saves', !r.error && (await row()).online_payment_mode === 'venue', r)
  const trail = await audits()
  check('every change is audited with the acting membership', trail.length === 4 && trail[1].actor_membership_id === mgr.membershipId && trail[0].actor_membership_id === ownerU.membershipId, trail.length)
  check('audit records old -> new', trail[0].before.mode === 'optional_full' && trail[0].after.mode === 'advance' && trail[1].before.mode === 'advance' && trail[3].after.mode === 'venue', trail)

  console.log('\n── roles ──')
  await saveBookingPaymentSettings({ mode: 'full' })
  const snapshot = JSON.stringify(await row())
  for (const u of others) {
    as(u, slugA)
    const res = await saveBookingPaymentSettings({ mode: 'venue' })
    check(`non-manager (membership ${u.membershipId.slice(0, 4)}) refused by the action`, Boolean(res.error), res)
  }
  check('…and the row is untouched', JSON.stringify(await row()) === snapshot)
  for (const u of others) {
    const upd = await asUser(u.id, (tx) => tx.execute(sql`update payment_settings set online_payment_mode='venue' where tenant_id=${A.tenantId} returning 1`)).then((x) => x.rows.length, () => -1)
    const sel = await asUser(u.id, (tx) => tx.execute(sql`select 1 from payment_settings where tenant_id=${A.tenantId}`)).then((x) => x.rows.length, () => -1)
    check('non-manager DB role: RLS blocks update and select of the row', upd <= 0 && sel === 0, { upd, sel })
  }
  as(bOwner, slugB)
  const cross = await saveBookingPaymentSettings({ mode: 'venue' })
  check("another tenant's owner only ever writes their own row", !cross.error && (await row(B.tenantId)).online_payment_mode === 'venue' && JSON.stringify(await row()) === snapshot, cross)

  console.log('\n── removing the secret ──')
  as(mgr, slugA)
  const clr = await clearRazorpaySecret()
  check('clearing the secret while in full mode succeeds with a notice', !clr.error && /Pay at venue/.test(clr.notice ?? ''), clr)
  rw = await row()
  check('…and the mode reverted to venue', rw.online_payment_mode === 'venue' && rw.advance_type === null, rw)
  const last = (await audits()).at(-1)!
  check('…audited as a revert', last.before.mode === 'full' && last.after.mode === 'venue', last)
  const again = await saveBookingPaymentSettings({ mode: 'full' })
  check('full is refused again now the secret is gone', Boolean(again.error), again)
  const plain = await clearRazorpaySecret()
  check('clearing when in venue mode gives no notice', !plain.error && !plain.notice, plain)

  await q(`delete from audit_log where tenant_id = any($1)`, [[A.tenantId, B.tenantId]]).catch(() => undefined)
  for (const t of [A, B]) await q('delete from tenants where id=$1', [t.tenantId])
  await q(`delete from users where email like $1`, [`pm-%-${tag}@example.test`])
  await owner.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
