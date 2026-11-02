/**
 * Slot-grid rule with a manager override (option 4 of the PR #43 decision):
 * staff paths refuse off-grid / out-of-hours slots, a manager or owner may
 * override with a reason, a cashier may not, the public path stays strict, and a
 * reschedule override is audited.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-slot-grid-override.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { resolveGridOverride, assertSlotsOnGrid, GridRefusedError } = await import('../lib/booking/slot-grid')
  const { withUser, withPublicTenant } = await import('../db')
  const { addDays, todayInZone, zonedTimeToUtc } = await import('../lib/booking/time')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'sgo'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'sgo co','active','Asia/Kolkata','gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
    [`mgr@${slug}.test`],
  )
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
     on conflict (tenant_id,user_id) do update set role='manager', status='active'`,
    [tenantId, u.rows[0].id],
  )
  await owner.query('delete from working_hours where branch_id=$1', [branchId]) // default 10:00-22:00

  const ctx = { tenantId, timezone: 'Asia/Kolkata' }
  const day = addDays(todayInZone('Asia/Kolkata'), 2)
  const at = (hm: string) => zonedTimeToUtc(day, hm, 'Asia/Kolkata').toISOString()
  const onGrid = [{ startsAt: at('12:00'), endsAt: at('13:00') }]
  const lateParty = [{ startsAt: at('22:30'), endsAt: at('23:30') }] // after close
  const offGrid = [{ startsAt: at('12:00'), endsAt: at('12:45') }] // 45 min

  const run = <T>(f: (tx: never) => Promise<T>) => withUser(u.rows[0].id, (tx) => f(tx as never))
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p
      return null
    } catch (e) {
      return e instanceof GridRefusedError ? e : (e as Error)
    }
  }

  check('on-grid slot passes untouched', (await run((tx) => resolveGridOverride(tx, ctx, branchId, onGrid, { mayOverride: false }))) === null)

  const cashier = await refusal(run((tx) => resolveGridOverride(tx, ctx, branchId, lateParty, { mayOverride: false, reason: 'party' })))
  check('a cashier is refused outside working hours, even with a reason', cashier instanceof GridRefusedError && cashier.canOverride === false, cashier)

  const mgrNoReason = await refusal(run((tx) => resolveGridOverride(tx, ctx, branchId, lateParty, { mayOverride: true })))
  check('a manager without a reason is refused, told they may override', mgrNoReason instanceof GridRefusedError && mgrNoReason.canOverride === true, mgrNoReason)

  const mgr = await run((tx) => resolveGridOverride(tx, ctx, branchId, lateParty, { mayOverride: true, reason: 'Private party' }))
  check('a manager with a reason overrides out-of-hours; the refusal is returned for the audit row', typeof mgr === 'string' && /working hours/.test(mgr), mgr)

  const mgrOff = await run((tx) => resolveGridOverride(tx, ctx, branchId, offGrid, { mayOverride: true, reason: 'Short demo' }))
  check('…and an off-grid 45-minute length', typeof mgrOff === 'string' && /multiple/.test(mgrOff), mgrOff)

  const blank = await refusal(run((tx) => resolveGridOverride(tx, ctx, branchId, offGrid, { mayOverride: true, reason: '   ' })))
  check('a blank reason does not override', blank instanceof GridRefusedError, blank)

  const pub = await refusal(withPublicTenant(tenantId, (tx) => assertSlotsOnGrid(tx as never, ctx, branchId, lateParty)))
  check('the public path stays strict', pub instanceof GridRefusedError && pub.canOverride === false, pub)

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
