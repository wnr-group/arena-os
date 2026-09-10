/**
 * Reporting infrastructure (AROS-64) — integration tests against a real database.
 *
 * Drives the production path end to end: fixtures go in as invoices, the
 * materialized view is refreshed by the same function the ops script calls, and
 * every assertion reads through getDailyRevenue() — which goes through
 * withUser() and the security-barrier view, exactly as a report page will.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-reporting.ts
 *
 * Covers:
 *   - the aggregate reconciles EXACTLY with the source invoices
 *   - 'issued' + 'paid' count; 'draft' and 'void' never do
 *   - many invoices on a day, many branches, many tenants
 *   - the day bucket is the BRANCH's local day, not UTC (no off-by-one)
 *   - date filters at both edges, plus every invalid range the helper rejects
 *   - CSV escaping: commas, quotes, newlines, nulls, numbers
 *   - the raw MV is unreadable by the app role
 */
import { Client } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { DailyRevenueRow } from '../lib/reports/daily-revenue'
import {
  DateRangeError,
  daysInRange,
  eachDay,
  isCalendarDate,
  lastNDays,
  parseDateRange,
  resolveDateRange,
} from '../lib/reports/date-range'
import { csvDownloadHeaders, csvLines, csvStream, escapeCsvValue, toCsv } from '../lib/reports/csv'
import type { ActiveContext } from '../lib/tenant/context'

let pass = 0,
  fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()

  // Imported AFTER loadEnv(): the reader pulls in db/index.ts, which builds its
  // connection pools the moment it is evaluated — a static import would run
  // that before .env.local had been read. Everything else here is pure and can
  // be imported normally.
  const { DAILY_REVENUE_CSV_COLUMNS, ReportAccessError, getDailyRevenue, sumDailyRevenue } = await import(
    '../lib/reports/daily-revenue'
  )

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()

  // ── fixtures (owner connection, bypasses RLS) ─────────────────────────────
  async function makeTenant(slug: string, email: string, timezone = TZ) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status, timezone) values ($1, $2, 'active', $3)
       on conflict (slug) do update set name = excluded.name, timezone = excluded.timezone returning id`,
      [slug, `${slug} co`, timezone],
    )
    // Entitlement enforcement is fail-closed (M16 #2): a tenant with no
    // plan is granted nothing, so this fixture states that it is a paying
    // customer. See scripts/entitle-fixture.ts.
    await entitleTenant(owner, t.rows[0].id)
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1, 'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id, user_id, role, status) values ($1, $2, 'owner', 'active')
       on conflict (tenant_id, user_id) do update set role = 'owner', status = 'active' returning id`,
      [t.rows[0].id, u.rows[0].id],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  async function makeBranch(tenantId: string, name: string, timezone: string | null = null) {
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name, timezone) values ($1, $2, $3)
       on conflict (tenant_id, name) do update set timezone = excluded.timezone returning id`,
      [tenantId, name, timezone],
    )
    return b.rows[0].id
  }

  let invoiceSeq = 0
  async function makeInvoice(
    tenantId: string,
    branchId: string,
    v: {
      status: 'draft' | 'issued' | 'paid' | 'void'
      issuedAt: string | null
      subtotal: number
      discount: number
      tax: number
      total: number
    },
  ) {
    invoiceSeq++
    await owner.query(
      `insert into invoices
         (tenant_id, branch_id, invoice_number, status, issued_at, subtotal, discount, tax_total, total)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        tenantId,
        branchId,
        `RPT-${String(invoiceSeq).padStart(4, '0')}`,
        v.status,
        v.issuedAt,
        v.subtotal.toFixed(2),
        v.discount.toFixed(2),
        v.tax.toFixed(2),
        v.total.toFixed(2),
      ],
    )
  }

  const A = await makeTenant('rpt-a', 'owner@rpt-a.test')
  const B = await makeTenant('rpt-b', 'owner@rpt-b.test')
  const A1 = await makeBranch(A.tenantId, 'A-main')
  const A2 = await makeBranch(A.tenantId, 'A-second')
  // Explicit branch timezone, DIFFERENT from the tenant's — the aggregate is
  // documented to bucket on the branch's clock when it has one.
  const A3 = await makeBranch(A.tenantId, 'A-utc', 'UTC')
  const B1 = await makeBranch(B.tenantId, 'B-main')

  // Start from a clean slate for these tenants so a re-run reconciles.
  await owner.query('delete from invoices where tenant_id = any($1)', [[A.tenantId, B.tenantId]])

  // 2026-03-10 IST — two billable invoices, plus a draft and a void that must
  // never be counted.
  await makeInvoice(A.tenantId, A1, { status: 'issued', issuedAt: '2026-03-10T06:00:00Z', subtotal: 1000, discount: 100, tax: 45, total: 945 })
  await makeInvoice(A.tenantId, A1, { status: 'paid', issuedAt: '2026-03-10T09:30:00Z', subtotal: 500, discount: 0, tax: 25, total: 525 })
  await makeInvoice(A.tenantId, A1, { status: 'draft', issuedAt: null, subtotal: 999, discount: 0, tax: 0, total: 999 })
  await makeInvoice(A.tenantId, A1, { status: 'void', issuedAt: '2026-03-10T07:00:00Z', subtotal: 888, discount: 0, tax: 0, total: 888 })
  // A second branch on the same day.
  await makeInvoice(A.tenantId, A2, { status: 'issued', issuedAt: '2026-03-10T08:00:00Z', subtotal: 300, discount: 0, tax: 15, total: 315 })
  // The next day.
  await makeInvoice(A.tenantId, A1, { status: 'issued', issuedAt: '2026-03-11T05:00:00Z', subtotal: 200, discount: 20, tax: 9, total: 189 })
  // Timezone boundary: 18:29Z is 23:59 IST on the 12th, 18:31Z is 00:01 IST on
  // the 13th. A UTC-bucketing aggregate would put both on the 12th.
  await makeInvoice(A.tenantId, A1, { status: 'issued', issuedAt: '2026-03-12T18:29:00Z', subtotal: 10, discount: 0, tax: 0, total: 10 })
  await makeInvoice(A.tenantId, A1, { status: 'issued', issuedAt: '2026-03-12T18:31:00Z', subtotal: 20, discount: 0, tax: 0, total: 20 })
  // Same instant, a branch pinned to UTC: 18:31Z is still the 12th there.
  await makeInvoice(A.tenantId, A3, { status: 'issued', issuedAt: '2026-03-12T18:31:00Z', subtotal: 40, discount: 0, tax: 0, total: 40 })
  // Another tenant, same day — must never appear in A's report.
  await makeInvoice(B.tenantId, B1, { status: 'issued', issuedAt: '2026-03-10T06:00:00Z', subtotal: 7777, discount: 77, tax: 7, total: 7707 })

  await owner.query('select public.refresh_daily_revenue()')

  // ── the context a report page would hand the reader ───────────────────────
  const ctxFor = (t: typeof A, tenantId: string, role = 'owner'): ActiveContext =>
    ({
      user: { id: t.userId, email: 'x@test', fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug: 'x', name: 'x', industry: 'gaming_cafe', status: 'active', currency: 'INR', timezone: TZ },
      role,
      membershipId: t.membershipId,
      branchId: null,
    }) as ActiveContext

  const ctxA = ctxFor(A, A.tenantId)
  const ctxB = ctxFor(B, B.tenantId)

  const wide = { start: '2026-01-01', end: '2026-12-31' }
  const rowsA = await getDailyRevenue(ctxA, { range: wide })
  const byKey = (rows: DailyRevenueRow[], day: string, branchId: string) =>
    rows.find((r) => r.day === day && r.branchId === branchId)

  console.log('\n── aggregation ──')
  const mar10A1 = byKey(rowsA, '2026-03-10', A1)
  check('2026-03-10 A-main exists in the aggregate', !!mar10A1)
  if (mar10A1) {
    check('gross = SUM(subtotal) = 1500.00', mar10A1.gross === 1500)
    check('discount = SUM(discount) = 100.00', mar10A1.discount === 100)
    check('tax = SUM(tax_total) = 70.00', mar10A1.tax === 70)
    check('net = SUM(total) = 1470.00', mar10A1.net === 1470)
    check('invoice_count counts only the billable rows (2)', mar10A1.invoiceCount === 2)
    check('…so the draft (999) is excluded', mar10A1.gross !== 2499 && mar10A1.net !== 2469)
    check('…and the void (888) is excluded', mar10A1.gross !== 2388)
  }

  const mar10A2 = byKey(rowsA, '2026-03-10', A2)
  check('the second branch is a SEPARATE row on the same day', !!mar10A2 && mar10A2.gross === 300)
  check('…and carries its own branch name', mar10A2?.branchName === 'A-second')

  const mar11 = byKey(rowsA, '2026-03-11', A1)
  check('the next day is its own row (gross 200, discount 20, tax 9, net 189)',
    !!mar11 && mar11.gross === 200 && mar11.discount === 20 && mar11.tax === 9 && mar11.net === 189)

  console.log('\n── day bucketing is the branch’s local day ──')
  check('23:59 IST (18:29Z) lands on 2026-03-12', byKey(rowsA, '2026-03-12', A1)?.gross === 10)
  check('00:01 IST (18:31Z) lands on 2026-03-13, NOT the 12th', byKey(rowsA, '2026-03-13', A1)?.gross === 20)
  check('a UTC branch buckets the same instant on 2026-03-12', byKey(rowsA, '2026-03-12', A3)?.gross === 40)

  console.log('\n── reconciliation against the source invoices ──')
  // The same rules, computed independently from `invoices` itself. If these two
  // ever disagree the aggregate has drifted from the ledger.
  const src = await owner.query<{ day: string; branch_id: string; gross: string; discount: string; tax: string; net: string; n: string }>(
    `select (i.issued_at at time zone coalesce(b.timezone, t.timezone))::date::text as day,
            i.branch_id,
            sum(i.subtotal)::text  as gross,
            sum(i.discount)::text  as discount,
            sum(i.tax_total)::text as tax,
            sum(i.total)::text     as net,
            count(*)::text         as n
       from invoices i
       join tenants  t on t.id = i.tenant_id
       join branches b on b.id = i.branch_id
      where i.tenant_id = $1 and i.status in ('issued','paid') and i.issued_at is not null
      group by 1, 2`,
    [A.tenantId],
  )
  check('the aggregate has exactly as many rows as the source groups', rowsA.length === src.rows.length)
  let mismatched = 0
  for (const s of src.rows) {
    const got = byKey(rowsA, s.day, s.branch_id)
    if (
      !got ||
      got.gross !== Number(s.gross) ||
      got.discount !== Number(s.discount) ||
      got.tax !== Number(s.tax) ||
      got.net !== Number(s.net) ||
      got.invoiceCount !== Number(s.n)
    ) {
      mismatched++
      console.log(`    ↳ mismatch on ${s.day}/${s.branch_id}: source ${JSON.stringify(s)} vs ${JSON.stringify(got)}`)
    }
  }
  check('every source group reconciles EXACTLY (gross/discount/tax/net/count)', mismatched === 0)

  const totals = sumDailyRevenue(rowsA)
  const grand = await owner.query<{ gross: string; net: string; n: string }>(
    `select coalesce(sum(subtotal),0)::text gross, coalesce(sum(total),0)::text net, count(*)::text n
       from invoices where tenant_id = $1 and status in ('issued','paid') and issued_at is not null`,
    [A.tenantId],
  )
  check('period totals match the source ledger (gross)', totals.gross === Number(grand.rows[0].gross))
  check('period totals match the source ledger (net)', totals.net === Number(grand.rows[0].net))
  check('period totals match the source ledger (invoice count)', totals.invoiceCount === Number(grand.rows[0].n))

  console.log('\n── tenant scoping (full isolation proof: verify-reporting-rls.ts) ──')
  check("tenant A's report contains no row from another tenant", rowsA.every((r) => [A1, A2, A3].includes(r.branchId)))
  const rowsB = await getDailyRevenue(ctxB, { range: wide })
  check('tenant B sees only its own row', rowsB.length === 1 && rowsB[0].gross === 7777)

  console.log('\n── date filters ──')
  const oneDay = await getDailyRevenue(ctxA, { range: { start: '2026-03-10', end: '2026-03-10' } })
  check('start = end returns that one day (both branches)', oneDay.length === 2 && oneDay.every((r) => r.day === '2026-03-10'))
  const twoDays = await getDailyRevenue(ctxA, { range: { start: '2026-03-10', end: '2026-03-11' } })
  check('a multi-day range includes both ends', twoDays.some((r) => r.day === '2026-03-10') && twoDays.some((r) => r.day === '2026-03-11'))
  check('…and nothing outside it', twoDays.every((r) => r.day >= '2026-03-10' && r.day <= '2026-03-11'))

  // The end date is INCLUSIVE — the classic off-by-one is asserted directly.
  const endInclusive = await getDailyRevenue(ctxA, { range: { start: '2026-03-11', end: '2026-03-12' } })
  check('the END date is inclusive (2026-03-12 is present)', endInclusive.some((r) => r.day === '2026-03-12'))
  check('the day AFTER the end is excluded (2026-03-13 absent)', !endInclusive.some((r) => r.day === '2026-03-13'))
  check('the day BEFORE the start is excluded (2026-03-10 absent)', !endInclusive.some((r) => r.day === '2026-03-10'))

  const empty = await getDailyRevenue(ctxA, { range: { start: '2026-04-01', end: '2026-04-30' } })
  check('a range with no invoices returns no rows (not an error)', empty.length === 0)

  const branchFiltered = await getDailyRevenue(ctxA, { range: wide, branchId: A2 })
  check('filtering by branch returns only that branch', branchFiltered.length === 1 && branchFiltered[0].branchId === A2)

  console.log('\n── date-range helper ──')
  check('start = end is one day, not zero', daysInRange({ start: '2026-03-10', end: '2026-03-10' }) === 1)
  check('a 3-day range counts 3', daysInRange({ start: '2026-03-10', end: '2026-03-12' }) === 3)
  check('eachDay lists both ends', JSON.stringify(eachDay({ start: '2026-03-10', end: '2026-03-12' })) === JSON.stringify(['2026-03-10', '2026-03-11', '2026-03-12']))
  check('a range spanning a month end counts correctly', daysInRange({ start: '2026-01-30', end: '2026-02-02' }) === 4)
  check('a leap day is a real date', isCalendarDate('2028-02-29'))
  check('2026-02-29 is NOT (not a leap year)', !isCalendarDate('2026-02-29'))
  check('2026-02-30 is rejected', !isCalendarDate('2026-02-30'))
  check('2026-13-01 is rejected', !isCalendarDate('2026-13-01'))
  check("'10-03-2026' is rejected (wrong order)", !isCalendarDate('10-03-2026'))
  check('an empty string is rejected', !isCalendarDate(''))

  const threw = (fn: () => unknown) => {
    try {
      fn()
      return null
    } catch (e) {
      return e
    }
  }
  check('parseDateRange accepts a valid range', JSON.stringify(parseDateRange({ start: '2026-03-01', end: '2026-03-31' })) === JSON.stringify({ start: '2026-03-01', end: '2026-03-31' }))
  check('start > end is REFUSED', threw(() => parseDateRange({ start: '2026-03-31', end: '2026-03-01' })) instanceof DateRangeError)
  check('an invalid start date is REFUSED', threw(() => parseDateRange({ start: '2026-02-30', end: '2026-03-01' })) instanceof DateRangeError)
  check('a missing date is REFUSED', threw(() => parseDateRange({ start: undefined, end: '2026-03-01' })) instanceof DateRangeError)
  check('a range beyond the cap is REFUSED', threw(() => parseDateRange({ start: '2020-01-01', end: '2026-01-01' })) instanceof DateRangeError)
  check('…and the cap is configurable', !!parseDateRange({ start: '2026-03-01', end: '2026-03-03' }, { maxDays: 3 }))

  const lenient = resolveDateRange({ start: 'nonsense', end: undefined }, { timeZone: TZ, defaultDays: 30, now: new Date('2026-03-15T12:00:00Z') })
  check('resolveDateRange falls back to the last 30 days ending today', lenient.end === '2026-03-15' && lenient.start === '2026-02-14')
  check('…which is exactly 30 days inclusive', daysInRange(lenient) === 30)
  const clamped = resolveDateRange({ start: '2026-03-20', end: '2026-03-10' }, { timeZone: TZ })
  check('resolveDateRange clamps a reversed range instead of throwing', clamped.start === clamped.end)
  const capped = resolveDateRange({ start: '2000-01-01', end: '2026-03-10' }, { timeZone: TZ, maxDays: 7 })
  check('resolveDateRange pulls an over-wide start forward', daysInRange(capped) === 7 && capped.end === '2026-03-10')
  const last7 = lastNDays(7, TZ, new Date('2026-03-15T12:00:00Z'))
  check('lastNDays(7) is 7 days ending today', last7.end === '2026-03-15' && last7.start === '2026-03-09' && daysInRange(last7) === 7)

  console.log('\n── CSV ──')
  check('a plain value is not quoted', escapeCsvValue('Coke') === 'Coke')
  check('a comma forces quotes', escapeCsvValue('Chicken, Large') === '"Chicken, Large"')
  check('a double quote is doubled and the field quoted', escapeCsvValue('Customer "Asha"') === '"Customer ""Asha"""')
  check('a newline is preserved inside quotes', escapeCsvValue('line one\nline two') === '"line one\nline two"')
  check('a CRLF value is quoted', escapeCsvValue('a\r\nb') === '"a\r\nb"')
  check('null becomes an empty field', escapeCsvValue(null) === '')
  check('undefined becomes an empty field', escapeCsvValue(undefined) === '')
  check('a number keeps its value, unquoted', escapeCsvValue(1470.5) === '1470.5')
  check('zero is written, not treated as empty', escapeCsvValue(0) === '0')
  check('a negative number survives', escapeCsvValue(-99.99) === '-99.99')
  check('NaN is written as empty, not "NaN"', escapeCsvValue(NaN) === '')
  check('a boolean is written as true/false', escapeCsvValue(true) === 'true')
  check('leading/trailing space is preserved by quoting', escapeCsvValue(' padded ') === '" padded "')
  check('a semicolon delimiter quotes on semicolons, not commas', escapeCsvValue('a;b', ';') === '"a;b"' && escapeCsvValue('a,b', ';') === 'a,b')

  type Row = { description: string; customer: string | null; note: string; qty: number }
  const csvRows: Row[] = [
    { description: 'Chicken, Large', customer: 'Customer "Asha"', note: 'first\nsecond', qty: 2 },
    { description: 'Coke', customer: null, note: '', qty: 10 },
  ]
  const cols = [
    { header: 'Description', value: (r: Row) => r.description },
    { header: 'Customer', value: (r: Row) => r.customer },
    { header: 'Note', value: (r: Row) => r.note },
    { header: 'Qty', value: (r: Row) => r.qty },
  ]
  const csv = toCsv(csvRows, cols)
  const expected =
    'Description,Customer,Note,Qty\r\n' +
    '"Chicken, Large","Customer ""Asha""","first\nsecond",2\r\n' +
    'Coke,,,10\r\n'
  check('toCsv produces exactly the expected document', csv === expected)
  check('…with a header row', csv.startsWith('Description,Customer,Note,Qty\r\n'))
  check('…CRLF-terminated per RFC 4180', csv.endsWith('\r\n'))
  check('header can be turned off', !toCsv(csvRows, cols, { header: false }).startsWith('Description'))
  const bomCsv = toCsv(csvRows, cols, { bom: true })
  check('the BOM is opt-in, written ONCE, and only at the very start', bomCsv === '﻿' + expected)
  check('csvLines yields header + one line per row', [...csvLines(csvRows, cols)].length === 3)

  const streamed = await readStream(csvStream(csvRows, cols))
  check('csvStream produces the same bytes as toCsv', streamed === expected)
  const asyncRows = (async function* () {
    for (const r of csvRows) yield r
  })()
  check('csvStream accepts an async iterable too', (await readStream(csvStream(asyncRows, cols))) === expected)

  const headers = csvDownloadHeaders('daily-revenue.csv')
  check('download headers name the file and disable caching',
    headers['Content-Type'].startsWith('text/csv') &&
      headers['Content-Disposition'] === 'attachment; filename="daily-revenue.csv"' &&
      headers['Cache-Control'] === 'no-store')

  const revenueCsv = toCsv(rowsA, DAILY_REVENUE_CSV_COLUMNS)
  const revenueLines = revenueCsv.trimEnd().split('\r\n')
  check('the revenue export has a header plus one line per row', revenueLines.length === rowsA.length + 1)
  check('…with the documented columns', revenueLines[0] === 'Day,Branch,Invoices,Gross,Discount,Tax,Net')
  check('…money at 2dp, unformatted, so a spreadsheet reads it as a number', revenueLines.some((l) => l.includes(',1500.00,100.00,70.00,1470.00')))

  console.log('\n── access + infrastructure ──')
  const cashierCtx = ctxFor(A, A.tenantId, 'cashier')
  let refused = false
  try {
    await getDailyRevenue(cashierCtx, { range: wide })
  } catch (e) {
    refused = e instanceof ReportAccessError
  }
  check('a cashier is refused by the reader (reports are owner/manager)', refused)

  let mvBlocked = false
  try {
    await app.query('select * from public.mv_daily_revenue limit 1')
  } catch {
    mvBlocked = true
  }
  check('the app role CANNOT read the raw materialized view', mvBlocked)

  const idx = await owner.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public' and tablename = 'mv_daily_revenue'`,
  )
  const names = idx.rows.map((r) => r.indexname)
  check('the UNIQUE index REFRESH … CONCURRENTLY requires exists', names.includes('mv_daily_revenue_key'))
  check('the (tenant_id, day) range index exists', names.includes('idx_mv_daily_revenue_tenant_day'))
  const unique = await owner.query<{ n: string }>(
    `select count(*)::text n from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = 'mv_daily_revenue_key' and i.indisunique`,
  )
  check('…and it really is UNIQUE', unique.rows[0].n === '1')

  // The plan is printed, not asserted on: at fixture scale Postgres will
  // rightly prefer a sequential scan, and asserting otherwise would encode a
  // falsehood. What matters — that the indexes exist — is checked above.
  await app.query('begin')
  await app.query(`select set_config('app.user_id', $1, true)`, [A.userId])
  const plan = await app.query<{ 'QUERY PLAN': string }>(
    `explain select day, branch_id, gross, net from public.v_daily_revenue
      where tenant_id = $1 and day between $2 and $3 order by day`,
    [A.tenantId, '2026-03-01', '2026-03-31'],
  )
  await app.query('commit')
  console.log('    query plan:')
  for (const r of plan.rows) console.log(`      ${r['QUERY PLAN']}`)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await owner.query(`delete from users where email like 'owner@rpt-%'`)
  await owner.query('select public.refresh_daily_revenue()')
  await owner.end()
  await app.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
