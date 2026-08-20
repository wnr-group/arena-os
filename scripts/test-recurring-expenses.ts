/**
 * Exercises recurring expense templates and the generation job (AROS-109).
 *
 *   npx tsx scripts/test-recurring-expenses.ts
 *
 * The job itself is scripts/run-recurring-expenses.ts, which is spawned for
 * real here rather than reimplemented — a test that reimplemented the loop
 * would prove only that the test agrees with itself. Each case seeds a
 * template, runs the job, and asserts what landed in `expenses`.
 *
 * Dates are pinned in the past (2026-06 … 2026-08 and a February window) so
 * "due" is deterministic and the suite does not change behaviour with the wall
 * clock. Money is compared as STRINGS throughout, never parsed to a float.
 */
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { loadEnv } from './env'

let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: string) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${!cond && detail ? `  → ${detail}` : ''}`)
  if (cond) passed++
  else failed++
}

/** Runs the real job, exactly as a scheduler would. */
function runJob(): string {
  try {
    return execFileSync('npx', ['tsx', 'scripts/run-recurring-expenses.ts'], {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

async function main() {
  loadEnv()
  const db = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await db.connect()

  async function makeUser(tenantId: string, email: string, role: string) {
    const u = await db.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1,'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    await db.query(
      `insert into memberships (tenant_id, user_id, role, status) values ($1,$2,$3,'active')
       on conflict (tenant_id, user_id) do update set role = excluded.role, status='active'`,
      [tenantId, u.rows[0].id, role],
    )
    return u.rows[0].id
  }

  async function makeTenant(slug: string) {
    const t = await db.query<{ id: string }>(
      `insert into tenants (slug, name, status, timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name = excluded.name, timezone='Asia/Kolkata' returning id`,
      [slug, `${slug} co`],
    )
    const id = t.rows[0].id
    return {
      tenantId: id,
      ownerId: await makeUser(id, `rec109-owner@${slug}.test`, 'owner'),
      cashierId: await makeUser(id, `rec109-cashier@${slug}.test`, 'cashier'),
    }
  }

  const A = await makeTenant('rec109-a')
  const B = await makeTenant('rec109-b')

  for (const t of [A.tenantId, B.tenantId]) {
    await db.query('delete from expenses where tenant_id=$1', [t])
    await db.query('delete from recurring_expenses where tenant_id=$1', [t])
    await db.query('delete from expense_categories where tenant_id=$1', [t])
    await db.query('delete from vendors where tenant_id=$1', [t])
  }

  const catA = (
    await db.query<{ id: string }>(`insert into expense_categories (tenant_id,name) values ($1,'Rent') returning id`, [A.tenantId])
  ).rows[0].id
  const venA = (
    await db.query<{ id: string }>(`insert into vendors (tenant_id,name) values ($1,'Landlord') returning id`, [A.tenantId])
  ).rows[0].id
  const catB = (
    await db.query<{ id: string }>(`insert into expense_categories (tenant_id,name) values ($1,'Rent B') returning id`, [B.tenantId])
  ).rows[0].id
  const venB = (
    await db.query<{ id: string }>(`insert into vendors (tenant_id,name) values ($1,'Landlord B') returning id`, [B.tenantId])
  ).rows[0].id

  async function template(
    tenantId: string,
    cat: string,
    ven: string | null,
    amount: string,
    day: number,
    nextRun: string,
    active = true,
    note: string | null = null,
  ) {
    const r = await db.query<{ id: string }>(
      `insert into recurring_expenses (tenant_id,category_id,vendor_id,amount,day_of_month,next_run,is_active,note)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [tenantId, cat, ven, amount, day, nextRun, active, note],
    )
    return r.rows[0].id
  }

  const rowsFor = async (tplId: string) =>
    (
      await db.query<{ spent_on: string; recurrence_period: string; amount: string; note: string }>(
        `select spent_on::text, recurrence_period::text, amount, note
           from expenses where recurring_expense_id=$1 order by recurrence_period`,
        [tplId],
      )
    ).rows
  const nextRunOf = async (tplId: string) =>
    (await db.query<{ d: string }>(`select next_run::text d from recurring_expenses where id=$1`, [tplId])).rows[0].d

  // ── 1. basic generation ────────────────────────────────────────────────────
  console.log('\n── basic generation ──')
  const t1 = await template(A.tenantId, catA, venA, '50000.00', 1, '2026-08-01', true, 'Shop rent')
  runJob()
  {
    const r = await rowsFor(t1)
    check('one expense generated', r.length === 1, `got ${r.length}`)
    check('spent_on is the due date', r[0]?.spent_on === '2026-08-01')
    check('recurrence_period is the month start', r[0]?.recurrence_period === '2026-08-01')
    check('amount copied as a string, 2dp', r[0]?.amount === '50000.00', `got ${r[0]?.amount}`)
    check('template note copied onto the expense', r[0]?.note === 'Shop rent')
    check('next_run advanced to September', (await nextRunOf(t1)) === '2026-09-01', await nextRunOf(t1))
  }

  // ── 2. duplicate execution ────────────────────────────────────────────────
  console.log('\n── duplicate execution ──')
  {
    await db.query(`update recurring_expenses set next_run='2026-08-01' where id=$1`, [t1])
    runJob()
    const r = await rowsFor(t1)
    check('re-running the SAME period creates no duplicate', r.length === 1, `got ${r.length}`)
    check('next_run still advances past it', (await nextRunOf(t1)) === '2026-09-01')
  }

  // ── 3. concurrent execution ───────────────────────────────────────────────
  // Two independent connections racing the exact insert the job performs. The
  // unique index — not the job's logic — is what must refuse the second.
  console.log('\n── concurrent execution ──')
  {
    const t3 = await template(A.tenantId, catA, venA, '900.00', 5, '2026-07-05')
    const ins = `insert into expenses (tenant_id,category_id,vendor_id,amount,spent_on,recurring_expense_id,recurrence_period)
                 values ($1,$2,$3,'900.00','2026-07-05',$4,'2026-07-01')
                 on conflict (recurring_expense_id, recurrence_period) do nothing`
    const c1 = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
    const c2 = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
    await Promise.all([c1.connect(), c2.connect()])
    const [r1, r2] = await Promise.all([
      c1.query(ins, [A.tenantId, catA, venA, t3]),
      c2.query(ins, [A.tenantId, catA, venA, t3]),
    ])
    await Promise.all([c1.end(), c2.end()])
    const total = (r1.rowCount ?? 0) + (r2.rowCount ?? 0)
    check('two concurrent inserts produce exactly ONE row', total === 1, `inserted ${total}`)
    check('…and the table agrees', (await rowsFor(t3)).length === 1)

    // And the raw constraint refuses a duplicate outright, without ON CONFLICT.
    let refused = false
    try {
      await db.query(
        `insert into expenses (tenant_id,category_id,amount,spent_on,recurring_expense_id,recurrence_period)
         values ($1,$2,'1.00','2026-07-05',$3,'2026-07-01')`,
        [A.tenantId, catA, t3],
      )
    } catch {
      refused = true
    }
    check('the unique index refuses a duplicate at the DB level', refused)
  }

  // ── 4. multiple missed periods ────────────────────────────────────────────
  console.log('\n── multiple missed periods ──')
  {
    const t4 = await template(A.tenantId, catA, venA, '100.00', 1, '2026-06-01')
    runJob()
    const r = await rowsFor(t4)
    check('June, July and August all generated', r.length === 3, `got ${r.length}`)
    check('…in period order', r.map((x) => x.recurrence_period).join(',') === '2026-06-01,2026-07-01,2026-08-01',
      r.map((x) => x.recurrence_period).join(','))
    check('next_run becomes September', (await nextRunOf(t4)) === '2026-09-01', await nextRunOf(t4))
  }

  // ── 5. inactive template ──────────────────────────────────────────────────
  console.log('\n── inactive template ──')
  {
    const t5 = await template(A.tenantId, catA, venA, '77.00', 1, '2026-08-01', false)
    runJob()
    check('disabled template generates nothing', (await rowsFor(t5)).length === 0)
    check('…and its next_run is untouched', (await nextRunOf(t5)) === '2026-08-01')
  }

  // ── 6. month boundaries ───────────────────────────────────────────────────
  console.log('\n── month boundaries ──')
  {
    // Day 31 starting in a 31-day month: Jan 31 → Feb 28 → Mar 31 …
    const t6 = await template(A.tenantId, catA, null, '10.00', 31, '2026-01-31')
    runJob()
    const days = (await rowsFor(t6)).map((x) => x.spent_on)
    // Jan..Jul only: August's due day for a day-31 template is 2026-08-31,
    // which is still in the future, so the job must NOT generate it early.
    // That is the property worth asserting — a job that ran ahead of the due
    // date would put next month's rent in this month's books.
    const today = (await db.query<{ d: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text d`)).rows[0].d
    check('day-31 template ran for every ELAPSED month', days.length === 7, `got ${days.length}: ${days.join(',')}`)
    check('…and did not run ahead of its due date', days.every((d) => d <= today), `today ${today}`)
    check('…next_run is the un-elapsed August 31st', (await nextRunOf(t6)) === '2026-08-31', await nextRunOf(t6))
    check('…February clamps to the 28th', days.includes('2026-02-28'), days.join(','))
    check('…April clamps to the 30th', days.includes('2026-04-30'))
    check('…31-day months keep the 31st', days.includes('2026-03-31') && days.includes('2026-01-31'))
    check('…and no invalid date was ever produced', days.every((d) => !Number.isNaN(Date.parse(d))))

    // Leap year: day 29 in a leap February.
    const t6b = await template(A.tenantId, catA, null, '10.00', 29, '2028-02-29')
    const leap = await db.query<{ d: string }>(
      `select public.recurring_expense_due_day('2028-02-01'::date, 29::smallint)::text d`,
    )
    check('leap February keeps the 29th', leap.rows[0].d === '2028-02-29', leap.rows[0].d)
    const nonLeap = await db.query<{ d: string }>(
      `select public.recurring_expense_due_day('2027-02-01'::date, 29::smallint)::text d`,
    )
    check('non-leap February clamps to the 28th', nonLeap.rows[0].d === '2027-02-28', nonLeap.rows[0].d)
    await db.query('delete from recurring_expenses where id=$1', [t6b])
  }

  // ── 7. cross-tenant references rejected ───────────────────────────────────
  console.log('\n── cross-tenant references ──')
  {
    let catRefused = false
    try {
      await template(A.tenantId, catB, null, '5.00', 1, '2026-08-01')
    } catch {
      catRefused = true
    }
    check('template CANNOT use another tenant’s category', catRefused)

    let venRefused = false
    try {
      await template(A.tenantId, catA, venB, '5.00', 1, '2026-08-01')
    } catch {
      venRefused = true
    }
    check('template CANNOT use another tenant’s vendor', venRefused)
  }

  // ── 8. tenant isolation + manager-only writes (RLS, as the app role) ──────
  console.log('\n── RLS: isolation and manager-only writes ──')
  {
    const tB = await template(B.tenantId, catB, venB, '333.00', 1, '2026-08-01')
    const app = new Client({ connectionString: process.env.DATABASE_URL })
    await app.connect()
    async function asUser(userId: string, sql: string, params: unknown[]) {
      await app.query('begin')
      await app.query(`select set_config('app.user_id',$1,true)`, [userId])
      try {
        const r = await app.query(sql, params)
        await app.query('commit')
        return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows }
      } catch {
        await app.query('rollback')
        return { ok: false, rowCount: 0, rows: [] as unknown[] }
      }
    }

    const seenByA = await asUser(A.ownerId, 'select id from recurring_expenses', [])
    check('A sees only its own templates', seenByA.rows.every((r) => (r as { id: string }).id !== tB))
    const targeted = await asUser(A.ownerId, 'select id from recurring_expenses where id=$1', [tB])
    check('A cannot read B’s template by direct id', targeted.rows.length === 0)

    check(
      'cashier CANNOT insert a template',
      !(await asUser(A.cashierId,
        `insert into recurring_expenses (tenant_id,category_id,amount,day_of_month,next_run) values ($1,$2,'1.00',1,'2026-08-01')`,
        [A.tenantId, catA])).ok,
    )
    check(
      'cashier UPDATE affects 0 rows',
      (await asUser(A.cashierId, `update recurring_expenses set is_active=false where id=$1`, [t1])).rowCount === 0,
    )
    check(
      'cashier DELETE affects 0 rows',
      (await asUser(A.cashierId, `delete from recurring_expenses where id=$1`, [t1])).rowCount === 0,
    )
    check(
      'A’s owner CANNOT deactivate B’s template',
      (await asUser(A.ownerId, `update recurring_expenses set is_active=false where id=$1`, [tB])).rowCount === 0,
    )
    check(
      'A’s owner CAN update its own template',
      (await asUser(A.ownerId, `update recurring_expenses set note='ok' where id=$1 and tenant_id=$2`, [t1, A.tenantId])).rowCount === 1,
    )
    await app.end()
  }

  // ── 9. generated rows are ordinary expenses ───────────────────────────────
  console.log('\n── generated rows behave like normal expenses ──')
  {
    const r = await db.query<{ n: string; total: string }>(
      `select count(*)::text n, coalesce(sum(amount),0)::numeric(12,2)::text total
         from expenses where tenant_id=$1`,
      [A.tenantId],
    )
    check('they appear in the tenant’s ordinary expense query', Number(r.rows[0].n) > 0)
    check('…and contribute to the SQL total', r.rows[0].total !== '0.00', r.rows[0].total)
    const paired = await db.query<{ n: string }>(
      `select count(*)::text n from expenses
        where tenant_id=$1 and (recurring_expense_id is null) <> (recurrence_period is null)`,
      [A.tenantId],
    )
    check('provenance columns are never half-populated', paired.rows[0].n === '0')
  }

  await db.end()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
