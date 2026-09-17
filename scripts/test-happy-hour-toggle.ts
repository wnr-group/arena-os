/**
 * Happy hours — stopping one, including while it is live.
 *
 * The bug this pins: `happy_hours.start_time` is a Postgres `time` column, so
 * every read hands back "13:00:00". The enable/disable toggle sent the whole
 * stored row back through upsertHappyHour(), whose schema accepted only
 * HH:MM — so the round trip failed validation and a live happy hour could not
 * be turned off at all. The UI offered the option and the server refused it.
 *
 * Two fixes, both covered here:
 *   - the time fields accept HH:MM and HH:MM:SS, normalising to HH:MM
 *   - setHappyHourActive() writes only `is_active`, so a toggle can no longer
 *     fail on fields nobody is changing, or clobber a concurrent edit
 *
 * The actions call requireManager(), which needs cookies() — hence the Next
 * runtime hook, the same one the M16 suites use.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-happy-hour-toggle.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { upsertHappyHour, setHappyHourActive } = await import('../lib/actions/happy-hours')
  const { activeHappyHours } = await import('../lib/happy-hours/apply')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testhhtoggle'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  await owner.query(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true`, [tenantId])
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
  const userId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active'`, [tenantId, userId])
  await owner.query('delete from happy_hours where tenant_id=$1', [tenantId])

  // requireManager() reads the session from cookies and the tenant slug from a
  // header. Both are REAL — a real sessions row looked up by the real session
  // code — and the runtime stub only supplies the jar Next would have.
  const token = randomBytes(32).toString('hex')
  await owner.query(
    `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')
     on conflict (id) do nothing`,
    [createHash('sha256').update(token).digest('hex'), userId],
  )
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  const rowOf = async (id: string) =>
    (await owner.query(`select * from happy_hours where id=$1`, [id])).rows[0]

  const idOf = async (name: string) =>
    (await owner.query(`select id from happy_hours where tenant_id=$1 and name=$2`,
      [tenantId, name])).rows[0]?.id as string

  // ══ 1. create one, the way the dialog does (HH:MM) ═══════════════════════
  console.log('\n── a happy hour, created from the form ──')
  {
    const r = await upsertHappyHour({
      name: 'Flash Friday',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: '00:00',
      endTime: '23:59',
      discountType: 'percentage',
      discountValue: 20,
      isActive: true,
    })
    check('created without error', !r.error)
    const row = await rowOf(await idOf('Flash Friday'))
    check('…and Postgres stores the time with seconds', row.start_time === '00:00:00')
    check('…active to begin with', row.is_active === true)
  }

  // ══ 2. it is LIVE, and it can be stopped ═════════════════════════════════
  console.log('\n── stopping it while it is live ──')
  {
    const id = await idOf('Flash Friday')
    const row = await rowOf(id)

    const live = activeHappyHours(
      [{
        id, name: row.name, daysOfWeek: row.days_of_week,
        startTime: row.start_time, endTime: row.end_time,
        discountType: row.discount_type, discountValue: row.discount_value,
        isActive: row.is_active,
      }],
      new Date(),
      TZ,
    )
    check('it really is live right now (all days, 00:00–23:59)', live.length === 1)

    const stop = await setHappyHourActive(id, false)
    check('stopping a LIVE happy hour succeeds', !stop.error)
    check('…and it is off in the database', (await rowOf(id)).is_active === false)

    const after = await activeHappyHours(
      [{
        id, name: row.name, daysOfWeek: row.days_of_week,
        startTime: row.start_time, endTime: row.end_time,
        discountType: row.discount_type, discountValue: row.discount_value,
        isActive: false,
      }],
      new Date(),
      TZ,
    )
    check('…so it stops applying immediately, inside its own window', after.length === 0)

    const back = await setHappyHourActive(id, true)
    check('re-enabling works too', !back.error && (await rowOf(id)).is_active === true)
  }

  // ══ 3. the exact round trip that used to fail ════════════════════════════
  // The old toggle sent the STORED row back through upsertHappyHour(), seconds
  // and all. That is what returned "Invalid start time".
  console.log('\n── the stored row, sent back verbatim ──')
  {
    const id = await idOf('Flash Friday')
    const row = await rowOf(id)
    check('the stored times carry seconds', row.start_time === '00:00:00' && row.end_time === '23:59:00')

    const r = await upsertHappyHour({
      id,
      name: row.name,
      daysOfWeek: row.days_of_week,
      startTime: row.start_time,
      endTime: row.end_time,
      discountType: row.discount_type,
      discountValue: Number(row.discount_value),
      isActive: false,
    })
    check('upsert now ACCEPTS a stored HH:MM:SS time', !r.error)
    check('…and the row is off', (await rowOf(id)).is_active === false)
    check('…with its window unchanged',
      (await rowOf(id)).start_time === '00:00:00' && (await rowOf(id)).end_time === '23:59:00')
    await setHappyHourActive(id, true)
  }

  // ══ 4. the validation that must still bite ═══════════════════════════════
  console.log('\n── still rejected ──')
  {
    const base = {
      name: 'Bad Hour',
      daysOfWeek: [1],
      discountType: 'percentage' as const,
      discountValue: 10,
      isActive: true,
    }
    const nonsense = await upsertHappyHour({ ...base, startTime: '25:00', endTime: '26:00' })
    check('an impossible hour is refused', Boolean(nonsense.error))
    const secondsJunk = await upsertHappyHour({ ...base, startTime: '10:00:99', endTime: '11:00' })
    check('…and so are impossible seconds', Boolean(secondsJunk.error))
    const backwards = await upsertHappyHour({ ...base, startTime: '15:00:00', endTime: '13:00:00' })
    check('an end before the start is refused even with seconds attached',
      backwards.error === 'End time must be after start time.')
    const over100 = await upsertHappyHour({ ...base, startTime: '10:00', endTime: '11:00', discountValue: 150 })
    check('over 100% is refused', over100.error === 'Percentage discount cannot exceed 100.')
    check('none of those created anything',
      (await owner.query(`select count(*)::int c from happy_hours where tenant_id=$1 and name='Bad Hour'`,
        [tenantId])).rows[0].c === 0)
  }

  // ══ 5. a toggle touches nothing else ═════════════════════════════════════
  console.log('\n── the toggle is surgical ──')
  {
    const id = await idOf('Flash Friday')
    const before = await rowOf(id)
    await setHappyHourActive(id, false)
    const after = await rowOf(id)
    check('only is_active moved',
      after.is_active === false &&
      after.name === before.name &&
      after.start_time === before.start_time &&
      after.end_time === before.end_time &&
      after.discount_value === before.discount_value &&
      String(after.days_of_week) === String(before.days_of_week))

    // RLS + the tenant filter: another tenant's id is simply not found.
    const other = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ('testhhother','other','active',$1)
       on conflict (slug) do update set name=excluded.name returning id`, [TZ])
    const otherHH = await owner.query<{ id: string }>(
      `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value)
       values ($1,'Theirs','{1}','10:00','11:00','percentage','10.00') returning id`, [other.rows[0].id])
    await setHappyHourActive(otherHH.rows[0].id, false)
    check("another tenant's happy hour is untouched",
      (await rowOf(otherHH.rows[0].id)).is_active === true)
    await owner.query('delete from happy_hours where tenant_id=$1', [other.rows[0].id])
  }

  g.__ARENA_TEST_SESSION = undefined
  g.__ARENA_TEST_HEADERS = undefined
  await owner.query('delete from sessions where user_id=$1', [userId])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
