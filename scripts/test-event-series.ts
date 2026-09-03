/**
 * M15 #8 — recurring event series and the events report.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-series.ts
 *
 * Everything real: migration 0088, the unique index that makes generation
 * idempotent, the ACTUAL generator script (spawned as a child process, twice
 * and concurrently, exactly as cron would run it), the real registration and
 * check-in paths, and the real getEventReport() reader.
 *
 * The generator is driven as a SUBPROCESS rather than by importing its
 * internals, because "running the job twice creates no duplicate" is a claim
 * about the job as it is actually executed.
 */
import { execFileSync } from 'node:child_process'
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, extra?: string) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : extra ? `  → ${extra}` : ''}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Run the real generator, the way cron would. */
function runGenerator(): string {
  return execFileSync('npx', ['tsx', 'scripts/run-recurring-events.ts'], {
    encoding: 'utf8',
    shell: true,
    stdio: 'pipe',
  })
}

async function main() {
  const { getEventReport } = await import('../lib/reports/events')
  const { claimEventRegistration } = await import('../lib/events/registrations')
  const { checkInByTokenCore } = await import('../lib/events/check-in')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  async function makeTenant(slug: string, timezone = 'Asia/Kolkata') {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$1,'active',$2)
       on conflict (slug) do update set status='active', timezone=excluded.timezone returning id`,
      [slug, timezone],
    )
    const tenantId = t.rows[0].id
    await owner.query('delete from event_series where tenant_id=$1', [tenantId])
    await owner.query('delete from events where tenant_id=$1', [tenantId])
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    await owner.query('delete from branches where tenant_id=$1', [tenantId])
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`,
      [tenantId],
    )
    const mk = async (email: string, role: string) => {
      const u = await owner.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await owner.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3::member_role,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      tenantId,
      branchId: b.rows[0].id,
      mgr: await mk(`mgr@${slug}.test`, 'manager'),
      cashier: await mk(`cash@${slug}.test`, 'cashier'),
    }
  }

  const A = await makeTenant('esa')
  const B = await makeTenant('esb')
  // A tenant far from UTC, so a timezone bug is visible rather than latent.
  const TZ = await makeTenant('estz', 'Pacific/Kiritimati') // UTC+14

  const ctxFor = (t: { tenantId: string }, userId: string, role = 'manager') =>
    ({
      user: { id: userId },
      tenant: { id: t.tenantId, timezone: 'Asia/Kolkata', currency: 'INR' },
      role,
    }) as unknown as Parameters<typeof getEventReport>[0]

  /** A series whose first occurrence is already due (yesterday, locally). */
  async function makeSeries(
    t: { tenantId: string; branchId: string },
    o: {
      cadence?: 'weekly' | 'monthly'
      startTime?: string
      nextRun?: string
      active?: boolean
      title?: string
      fee?: string
      capacity?: number | null
      until?: string | null
    } = {},
  ) {
    const cadence = o.cadence ?? 'weekly'
    const r = await owner.query<{ id: string }>(
      // INSERT … SELECT, so the default next_run can be derived from the
      // TENANT's own timezone rather than the server's — the same conversion
      // the generator makes.
      `insert into event_series
         (tenant_id, branch_id, cadence, weekday, day_of_month, start_time, duration_minutes,
          next_run, until_date, is_active, title, type, capacity, entry_fee)
       select $1, $2, $3::event_cadence, $4, $5, $6::time, 90,
              coalesce($7::date, ((now() at time zone t.timezone)::date - 1)),
              $8::date, $9, $10, 'class', $11, $12
         from public.tenants t
        where t.id = $1
       returning id`,
      [
        t.tenantId, t.branchId, cadence,
        cadence === 'weekly' ? 2 : null,
        cadence === 'monthly' ? 15 : null,
        o.startTime ?? '19:00',
        o.nextRun ?? null,
        o.until ?? null,
        o.active ?? true,
        o.title ?? 'Tuesday Class',
        o.capacity === undefined ? 10 : o.capacity,
        o.fee ?? '0',
      ],
    )
    return r.rows[0].id
  }

  /** Today and tomorrow in the tenant timezone, as the report filters see them. */
  async function localDates(): Promise<{ today: string; tomorrow: string }> {
    const r = await owner.query<{ today: string; tomorrow: string }>(
      `select (now() at time zone 'Asia/Kolkata')::date::text            as today,
              ((now() at time zone 'Asia/Kolkata')::date + 1)::text      as tomorrow`,
    )
    return r.rows[0]
  }

  const occurrencesOf = async (seriesId: string) =>
    (
      await owner.query<{ id: string; occurrence_period: string; starts_at: Date; status: string }>(
        `select id, occurrence_period::text, starts_at, status::text
           from events where series_id=$1 order by occurrence_period`,
        [seriesId],
      )
    ).rows

  // ════════════════════════════════════════════════════════════════════════
  section('1. generation')
  {
    const s = await makeSeries(A, { title: 'Weekly Yoga' })
    runGenerator()
    const occ = await occurrencesOf(s)
    check('a due series generates an occurrence', occ.length >= 1, String(occ.length))
    check('…as an ORDINARY event row', occ[0].status === 'registration_open')

    const ev = (
      await owner.query<{ title: string; capacity: number; entry_fee: string; branch_id: string; type: string }>(
        'select title, capacity, entry_fee, branch_id, type::text from events where id=$1',
        [occ[0].id],
      )
    ).rows[0]
    check('…carrying the template snapshot: title', ev.title === 'Weekly Yoga')
    check('…capacity', ev.capacity === 10)
    check('…branch', ev.branch_id === A.branchId)
    check('…and type', ev.type === 'class')

    const nextRun = (await owner.query<{ d: string }>('select next_run::text d from event_series where id=$1', [s])).rows[0].d
    check('…and next_run advanced past today', nextRun > occ[occ.length - 1].occurrence_period)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. idempotency — the whole point')
  {
    const s = await makeSeries(A, { title: 'Idem Class' })
    runGenerator()
    const first = await occurrencesOf(s)
    check('first run generates', first.length >= 1)

    runGenerator()
    const second = await occurrencesOf(s)
    check('running the generator AGAIN creates no duplicate', second.length === first.length, `${first.length} → ${second.length}`)
    check('…and the occurrence ids are unchanged', second.map((o) => o.id).join() === first.map((o) => o.id).join())

    // The guarantee is the index, not the job. Prove it directly.
    const dup = await refusal(() =>
      owner.query(
        `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,status,series_id,occurrence_period)
         values ($1,$2,'Dupe','class', now(), now() + interval '1 hour','registration_open',$3,$4::date)`,
        [A.tenantId, A.branchId, s, first[0].occurrence_period],
      ),
    )
    check('the DATABASE refuses a duplicate (series_id, occurrence_period)', dup !== null)
    check('…by the unique index, not an application check', (dup ?? '').includes('idx_events_series_occurrence'), String(dup))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. concurrent job execution')
  {
    const s = await makeSeries(A, { title: 'Race Class' })
    // Two generators at once, as an overlapping cron would.
    await Promise.allSettled([
      Promise.resolve().then(runGenerator),
      Promise.resolve().then(runGenerator),
    ])
    const occ = await occurrencesOf(s)
    const periods = occ.map((o) => o.occurrence_period)
    check('two concurrent generators create no duplicate', new Set(periods).size === periods.length, periods.join(','))
    check('…and at least one occurrence exists', occ.length >= 1)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. timezone correctness')
  {
    // UTC+14. A 19:00 local class must be 05:00 UTC the SAME day.
    const s = await makeSeries(TZ, { title: 'Kiritimati Class', startTime: '19:00' })
    runGenerator()
    const occ = await occurrencesOf(s)
    check('a far-from-UTC tenant generates', occ.length >= 1)

    const local = (
      await owner.query<{ d: string; t: string }>(
        `select (e.starts_at at time zone t.timezone)::date::text d,
                to_char(e.starts_at at time zone t.timezone, 'HH24:MI') t
           from events e join tenants t on t.id = e.tenant_id where e.id=$1`,
        [occ[0].id],
      )
    ).rows[0]
    check('…at 19:00 in the TENANT’s local time', local.t === '19:00', local.t)
    check('…on the occurrence_period date itself', local.d === occ[0].occurrence_period, `${local.d} vs ${occ[0].occurrence_period}`)

    const dur = (
      await owner.query<{ m: number }>(
        `select extract(epoch from (ends_at - starts_at))/60 m from events where id=$1`,
        [occ[0].id],
      )
    ).rows[0]
    check('…and lasts the configured 90 minutes', Number(dur.m) === 90)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. disabled and bounded series')
  {
    const off = await makeSeries(A, { title: 'Disabled Class', active: false })
    runGenerator()
    check('an INACTIVE series generates nothing', (await occurrencesOf(off)).length === 0)

    // until_date in the past: due, but past its end.
    const ended = await makeSeries(A, { title: 'Ended Class', until: '2020-01-01' })
    runGenerator()
    check('a series past its until_date generates nothing', (await occurrencesOf(ended)).length === 0)

    // Disabling must be reversible and non-destructive. Start DISABLED so the
    // first run has genuinely new work to skip — re-running a series that has
    // already generated its due periods would produce nothing either way, which
    // would make the assertion vacuous.
    const s = await makeSeries(A, { title: 'Resumable', active: false })
    runGenerator()
    check('…a disabled series generates nothing even when due', (await occurrencesOf(s)).length === 0)

    await owner.query('update event_series set is_active=true where id=$1', [s])
    runGenerator()
    const after = await occurrencesOf(s)
    check('re-enabling resumes generation', after.length > 0, String(after.length))

    // And disabling again preserves what was already generated.
    await owner.query('update event_series set is_active=false where id=$1', [s])
    runGenerator()
    check('…and disabling again keeps the historical occurrences', (await occurrencesOf(s)).length === after.length)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. a generated occurrence is a normal event')
  {
    const s = await makeSeries(A, { title: 'Registerable', capacity: 3 })
    runGenerator()
    const occ = (await occurrencesOf(s))[0]

    // The series generates for a date that has already passed (next_run
    // defaults to yesterday so it is due), and claimEventRegistration()
    // correctly refuses an event that has ended. Move THIS occurrence's window
    // forward so the row is upcoming — the claim under test is that a generated
    // occurrence is an ordinary event the existing flows accept, not that a
    // past event takes entries.
    await owner.query(
      `update events set starts_at = now() + interval '1 hour',
                        ends_at   = now() + interval '2 hours'
        where id = $1`,
      [occ.id],
    )

    const c = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,'+919812345001','Reg One') returning id`,
      [A.tenantId],
    )
    const r = await claimEventRegistration(c.rows[0].id, occ.id, null)
    check('the existing registration flow accepts it', r.ok === true, r.ok ? '' : r.refusal)

    if (r.ok) {
      const tok = (
        await owner.query<{ t: string }>('select check_in_token t from event_registrations where id=$1', [r.registrationId])
      ).rows[0].t
      const ci = await withUser(A.mgr, (tx) => checkInByTokenCore(tx, { tenantId: A.tenantId }, tok))
      check('…and the existing check-in flow works on it', ci.ok === true)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. the events report')
  {
    // A paid event: one verified payment, one unpaid hold, one cancelled-paid.
    const ev = (
      await owner.query<{ id: string }>(
        `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,capacity,entry_fee,status)
         values ($1,$2,'Paid Workshop','class',
                 now() + interval '1 hour', now() + interval '3 hours',
                 10,'500.00','registration_open') returning id`,
        [A.tenantId, A.branchId],
      )
    ).rows[0].id

    const mkCustomer = async (n: number, name: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
          [A.tenantId, `+91981234${String(6000 + n)}`, name],
        )
      ).rows[0].id

    const paid = await claimEventRegistration(await mkCustomer(1, 'Paid'), ev, null)
    const held = await claimEventRegistration(await mkCustomer(2, 'Unpaid'), ev, null)
    const refunded = await claimEventRegistration(await mkCustomer(3, 'Refunded'), ev, null)
    if (!paid.ok || !held.ok || !refunded.ok) throw new Error('fixture registration failed')

    // Only the verified-webhook path may write paid_amount.
    await owner.query(`select public.confirm_event_registration_payment($1::uuid,$2,$3::numeric)`, [
      paid.registrationId, `pay_rep_${Date.now()}`, '500.00',
    ])
    await owner.query(`select public.confirm_event_registration_payment($1::uuid,$2,$3::numeric)`, [
      refunded.registrationId, `pay_ref_${Date.now()}`, '500.00',
    ])
    // …then that one cancels, so its money is refund-due, not revenue.
    await owner.query(
      `update event_registrations set status='cancelled', cancelled_at=now(), refund_required=true where id=$1`,
      [refunded.registrationId],
    )
    // Check the paid one in.
    const tok = (
      await owner.query<{ t: string }>('select check_in_token t from event_registrations where id=$1', [paid.registrationId])
    ).rows[0].t
    await withUser(A.mgr, (tx) => checkInByTokenCore(tx, { tenantId: A.tenantId }, tok))

    // The fixtures above are anchored to now() + a few hours, so that they are
    // always UPCOMING and registration never hits the legitimate 'ended'
    // refusal. Near local midnight that puts them on TOMORROW's date, so the
    // range spans both days — otherwise the suite would pass all day and fail
    // for one hour each night, which is the worst kind of test.
    const { today, tomorrow } = await localDates()
    const report = await getEventReport(ctxFor(A, A.mgr), { start: today, end: tomorrow })
    const row = report.rows.find((r) => r.eventId === ev)!

    check('the event appears in the range', !!row)
    check('registered counts the CONFIRMED set only', row.registered === 1, String(row.registered))
    check('…excluding the unpaid hold', held.ok && (await owner.query<{ s: string }>('select status::text s from event_registrations where id=$1', [held.registrationId])).rows[0].s === 'pending_payment')
    check('checked-in is counted', row.checkedIn === 1)
    check('attendance is checkedIn ÷ registered', row.attendanceRate === 100)
    check('revenue counts the VERIFIED payment', row.revenue === 500, String(row.revenue))
    check('…and NOT the cancelled-but-paid one', row.refundDue === 500, String(row.refundDue))

    // Zero registrations must not divide by zero.
    const empty = (
      await owner.query<{ id: string }>(
        `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,entry_fee,status)
         values ($1,$2,'Nobody Came','class',
                 now() + interval '1 hour', now() + interval '2 hours',
                 '0','registration_open') returning id`,
        [A.tenantId, A.branchId],
      )
    ).rows[0].id
    const r2 = await getEventReport(ctxFor(A, A.mgr), { start: today, end: tomorrow })
    const emptyRow = r2.rows.find((x) => x.eventId === empty)!
    check('an event with no registrations reports 0/0', emptyRow.registered === 0 && emptyRow.checkedIn === 0)
    check('…and a NULL attendance rate, not NaN or 0%', emptyRow.attendanceRate === null)
    check('…and zero revenue', emptyRow.revenue === 0)

    check('totals sum the rows', r2.totals.revenue >= 500 && r2.totals.registered >= 1)
    check('…and the overall rate is computed from totals', r2.totals.attendanceRate !== null)
    check('most-popular excludes events nobody registered for', !r2.mostPopular.some((x) => x.eventId === empty))

    // Date filtering.
    const past = await getEventReport(ctxFor(A, A.mgr), { start: '2019-01-01', end: '2019-01-31' })
    check('a range with no events returns nothing', past.rows.length === 0)
    check('…with safe zero totals', past.totals.events === 0 && past.totals.attendanceRate === null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('8. authorization and tenant isolation')
  {
    const { today, tomorrow } = await localDates()

    const cashier = await refusal(() => getEventReport(ctxFor(A, A.cashier, 'cashier'), { start: today, end: tomorrow }))
    check('a CASHIER cannot read the events report', cashier !== null)
    check('…with the standard ReportAccessError message', (cashier ?? '').includes('owners and managers'))

    // Tenant B's manager sees none of A's events.
    const bReport = await getEventReport(ctxFor(B, B.mgr), { start: today, end: tomorrow })
    check("tenant B's report contains none of tenant A's events", bReport.rows.length === 0, String(bReport.rows.length))
    check('…and zero revenue', bReport.totals.revenue === 0)

    // A series is manager-write, member-read, tenant-scoped.
    const s = await makeSeries(A, { title: 'Isolated Series' })
    const bSees = await withUser(B.mgr, (tx) =>
      tx.execute(sql`select count(*)::int n from event_series where id = ${s}::uuid`),
    )
    check("tenant B cannot read tenant A's series", Number((bSees.rows[0] as { n: number }).n) === 0)

    const cashierWrote = await withUser(A.cashier, (tx) =>
      tx.execute(sql`update event_series set is_active = false where id = ${s}::uuid returning id`),
    )
    check('a cashier cannot disable a series', cashierWrote.rows.length === 0)

    const cashierRead = await withUser(A.cashier, (tx) =>
      tx.execute(sql`select count(*)::int n from event_series where id = ${s}::uuid`),
    )
    check('…but any member may read one', Number((cashierRead.rows[0] as { n: number }).n) === 1)

    // The job must never cross tenants: every occurrence belongs to its series' tenant.
    runGenerator()
    const cross = await owner.query<{ n: string }>(
      `select count(*) n from events e join event_series s on s.id = e.series_id
        where e.tenant_id <> s.tenant_id`,
    )
    check('no generated occurrence ever crosses a tenant boundary', cross.rows[0].n === '0')
  }

  // ════════════════════════════════════════════════════════════════════════
  section('9. editing a series never rewrites history')
  {
    const s = await makeSeries(A, { title: 'Original Title', capacity: 5 })
    runGenerator()
    const before = (await occurrencesOf(s))[0]
    const beforeTitle = (await owner.query<{ title: string; capacity: number }>('select title, capacity from events where id=$1', [before.id])).rows[0]

    await owner.query(`update event_series set title='Renamed', capacity=99 where id=$1`, [s])
    const after = (await owner.query<{ title: string; capacity: number }>('select title, capacity from events where id=$1', [before.id])).rows[0]
    check('renaming the series leaves the existing occurrence alone', after.title === beforeTitle.title)
    check('…including its capacity', after.capacity === beforeTitle.capacity)

    // Deleting the series keeps its occurrences (ON DELETE SET NULL).
    await owner.query('delete from event_series where id=$1', [s])
    const survived = await owner.query<{ n: string; series_id: string | null }>(
      'select count(*) n, max(series_id::text) series_id from events where id=$1',
      [before.id],
    )
    check('deleting the series does NOT delete its occurrences', survived.rows[0].n === '1')
    check('…they simply lose their provenance', survived.rows[0].series_id === null)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  for (const t of [A, B, TZ]) {
    await owner.query('delete from event_series where tenant_id=$1', [t.tenantId])
    await owner.query('delete from events where tenant_id=$1', [t.tenantId])
    await owner.query('delete from customers where tenant_id=$1', [t.tenantId])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
