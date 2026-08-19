/**
 * Proves the booking-engine invariants against a real database:
 *   - the GiST exclusion constraint blocks overlapping active slots on a resource
 *   - cancelling a booking frees its time (active-sync trigger) so it can rebook
 *   - RLS on bookings/booking_slots hides other tenants' bookings from the app role
 *
 *   npx tsx scripts/verify-booking.ts
 */
import { Client } from 'pg'
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
  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await owner.connect()
  await app.connect()

  // ── fixtures via owner (bypasses RLS) ─────────────────────────────────────
  const demoTenant = (await owner.query("select id from tenants where slug='demo'")).rows[0].id
  const demoUser = (await owner.query("select id from users where email='owner@demo.test'")).rows[0].id
  const demoBranch = (await owner.query('select id from branches where tenant_id=$1 and is_primary', [demoTenant])).rows[0].id
  const resource = (await owner.query('select id, name from resources where tenant_id=$1 order by sort_order limit 1', [demoTenant])).rows[0]

  // a separate tenant with its own booking, to test cross-tenant visibility
  const other = (
    await owner.query(
      `insert into tenants (slug,name,status) values ('verifyother','Other','active')
       on conflict (slug) do update set name=excluded.name returning id`,
    )
  ).rows[0].id
  const otherBranch = (
    await owner.query(
      `insert into branches (tenant_id,name,is_primary) values ($1,'B',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [other],
    )
  ).rows[0].id
  const otherBooking = (
    await owner.query(
      `insert into bookings (tenant_id,branch_id,booking_number,total) values ($1,$2,'OTHER-1','0')
       on conflict (tenant_id,booking_number) do update set total='0' returning id`,
      [other, otherBranch],
    )
  ).rows[0].id

  // clean any prior test bookings on our resource
  await owner.query(
    `delete from bookings where tenant_id=$1 and booking_number like 'VERIFY-%'`,
    [demoTenant],
  )

  // ── app-role assertions as the demo owner ─────────────────────────────────
  async function asDemo<T>(fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [demoUser])
    try {
      return await fn()
    } finally {
      await app.query('commit')
    }
  }

  const t14 = '2099-01-01T14:00:00Z'
  const t16 = '2099-01-01T16:00:00Z'
  const t15 = '2099-01-01T15:00:00Z'
  const t17 = '2099-01-01T17:00:00Z'

  async function makeBooking(num: string, start: string, end: string) {
    // returns true on success, false if the exclusion constraint (23P01) fired
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [demoUser])
    try {
      const b = await app.query(
        `insert into bookings (tenant_id,branch_id,booking_number,total) values ($1,$2,$3,'0') returning id`,
        [demoTenant, demoBranch, num],
      )
      await app.query(
        `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name)
         values ($1,$2,$3,$4,$5,$6,'t')`,
        [demoTenant, b.rows[0].id, resource.id, start, end, resource.name],
      )
      await app.query('commit')
      return b.rows[0].id as string
    } catch (e) {
      await app.query('rollback')
      if (e && typeof e === 'object' && (e as { code?: string }).code === '23P01') return null
      throw e
    }
  }

  const first = await makeBooking('VERIFY-1', t14, t16)
  check('first booking 14:00–16:00 created', first !== null)

  const overlap = await makeBooking('VERIFY-2', t15, t17)
  check('overlapping booking 15:00–17:00 REJECTED by exclusion constraint', overlap === null)

  // cross-tenant read
  await asDemo(async () => {
    const r = await app.query('select id from bookings where id=$1', [otherBooking])
    check('demo cannot see the other tenant’s booking (RLS)', r.rows.length === 0)
    const own = await app.query("select id from bookings where booking_number='VERIFY-1'")
    check('demo CAN see its own booking', own.rows.length === 1)
  })

  // cancel frees the time
  await asDemo(async () => {
    await app.query(`update bookings set status='cancelled' where id=$1`, [first])
  })
  const afterCancel = await makeBooking('VERIFY-3', t15, t17)
  check('after cancelling, the freed 15:00–17:00 slot can be rebooked', afterCancel !== null)

  // cleanup
  await owner.query(`delete from bookings where tenant_id=$1 and booking_number like 'VERIFY-%'`, [demoTenant])
  await owner.query('delete from tenants where id=$1', [other])
  await owner.end()
  await app.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
