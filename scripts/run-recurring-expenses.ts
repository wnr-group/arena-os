/**
 * Generates the expenses due from recurring templates (AROS-109).
 *
 *   npx tsx scripts/run-recurring-expenses.ts
 *
 * WHY THIS IS A SCRIPT AND NOT AN HTTP CRON ENDPOINT. This project has no
 * scheduler — no cron route, no job table, no queue, no CRON_SECRET — and the
 * notification/reminder work that would introduce one is still M3-C on the
 * roadmap. The ONE established pattern for scheduled work here is
 * scripts/refresh-reports.ts: a tsx script, run as the OWNER role, invoked by a
 * host scheduler. This follows it exactly rather than inventing a second
 * architecture. Run it daily, after midnight in your busiest tenant's zone:
 *
 *   30 0 * * * cd /srv/arena-os && npx tsx scripts/run-recurring-expenses.ts
 *
 * Running it more often is harmless — see IDEMPOTENCY below — so an hourly
 * schedule is also fine and gives every timezone its own midnight.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * Runs as arena_owner, which is RLS-exempt, exactly like migrations and the
 * report refresh: generating across every tenant at once is an owner-level
 * operation and there is no session to scope it to. Nothing is taken from a
 * caller — no tenant id, no period, no template id — every value is read from
 * the database. There is no HTTP surface to authenticate.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * The guarantee is the unique index idx_expenses_recurrence_period on
 * (recurring_expense_id, recurrence_period), NOT the checks in this file. Every
 * insert is ON CONFLICT DO NOTHING against it, so:
 *
 *   * a second run in the same period inserts nothing;
 *   * two jobs racing on the same template cannot both win — one blocks on the
 *     SELECT … FOR UPDATE, and even if the lock were removed the index would
 *     still refuse the second insert;
 *   * a conflict is a no-op, not an error, so the job never fails over a
 *     duplicate it was always going to skip.
 *
 * ── TRANSACTIONS ────────────────────────────────────────────────────────────
 * One transaction PER TEMPLATE, covering both the generated expenses and the
 * next_run advance, so the two commit together or not at all. next_run is never
 * advanced past a period whose expense did not commit. A template that throws
 * rolls back alone and the loop continues with the next one — the same
 * "keep going, report at the end" shape the other scripts use.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

/** A runaway guard. 600 monthly periods is 50 years — far past any real
 *  backlog, and a cheap stop against a template whose date maths went wrong. */
const MAX_PERIODS_PER_TEMPLATE = 600

type DueTemplate = {
  id: string
  tenant_id: string
  next_run: string
  today: string
}

async function main() {
  loadEnv()

  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set in .env.local')

  const client = new Client({ connectionString: url })
  await client.connect()
  const started = Date.now()

  // Due = active AND next_run <= the TENANT's today. The tenant's timezone, not
  // the server's: a template due on the 1st must not fire while it is still the
  // 31st in Kolkata. Resolved with an `at time zone` cast in SQL — no ad-hoc
  // timezone arithmetic in JavaScript.
  const { rows: due } = await client.query<DueTemplate>(`
    select r.id,
           r.tenant_id,
           r.next_run::text                              as next_run,
           (now() at time zone t.timezone)::date::text   as today
      from public.recurring_expenses r
      join public.tenants t on t.id = r.tenant_id
     where r.is_active
       and r.next_run <= (now() at time zone t.timezone)::date
     order by r.tenant_id, r.next_run
  `)

  console.log(`→ ${due.length} template(s) due`)

  let generated = 0
  let skipped = 0
  let advanced = 0
  let failed = 0

  for (const t of due) {
    try {
      await client.query('begin')

      // Re-read under a row lock. A concurrent job holding this lock will have
      // advanced next_run by the time we get it, so the loop below simply finds
      // nothing due — the lock turns a race into a no-op instead of a conflict.
      const { rows: locked } = await client.query<{
        next_run: string
        day_of_month: number
        is_active: boolean
      }>(
        `select next_run::text, day_of_month, is_active
           from public.recurring_expenses
          where id = $1
          for update`,
        [t.id],
      )
      const tpl = locked[0]
      if (!tpl || !tpl.is_active) {
        await client.query('rollback')
        continue
      }

      let cursor = tpl.next_run
      let made = 0
      let periods = 0

      // EVERY missed period is generated, not just the latest one. A template
      // last run in June, processed in August, produces June, July AND August —
      // the money was owed for each of those months and a P&L that silently
      // dropped two of them would be wrong. next_run then lands on September.
      while (cursor <= t.today && periods < MAX_PERIODS_PER_TEMPLATE) {
        const { rowCount } = await client.query(
          `insert into public.expenses
             (tenant_id, category_id, vendor_id, amount, spent_on, note,
              recurring_expense_id, recurrence_period)
           select r.tenant_id, r.category_id, r.vendor_id, r.amount,
                  $2::date,
                  coalesce(r.note, 'Recurring expense'),
                  r.id,
                  date_trunc('month', $2::date)::date
             from public.recurring_expenses r
            where r.id = $1
           on conflict (recurring_expense_id, recurrence_period) do nothing`,
          [t.id, cursor],
        )

        if (rowCount && rowCount > 0) made++
        else skipped++

        // Advance to the next month's due day, re-applying the month-end rule
        // in SQL so February and the 31st behave identically everywhere.
        const { rows: nxt } = await client.query<{ d: string }>(
          `select public.recurring_expense_due_day(
                    (date_trunc('month', $1::date) + interval '1 month')::date,
                    $2::smallint
                  )::text as d`,
          [cursor, tpl.day_of_month],
        )
        cursor = nxt[0].d
        periods++
      }

      if (periods >= MAX_PERIODS_PER_TEMPLATE) {
        console.warn(`  ! template ${t.id} hit the ${MAX_PERIODS_PER_TEMPLATE}-period cap; advancing anyway`)
      }

      // Same transaction as the inserts above: next_run cannot move unless the
      // expenses it accounts for committed.
      await client.query('update public.recurring_expenses set next_run = $2 where id = $1', [t.id, cursor])
      await client.query('commit')

      generated += made
      advanced++
      console.log(`  ✓ ${t.id}  ${made} generated, next_run → ${cursor}`)
    } catch (e) {
      await client.query('rollback').catch(() => {})
      failed++
      // Keep going: one malformed template must not stop the rest of the run.
      console.error(`  ✗ ${t.id} failed:`, e instanceof Error ? e.message : e)
    }
  }

  console.log(
    `done — ${generated} expense(s) generated, ${skipped} already present, ` +
      `${advanced} template(s) advanced, ${failed} failed (${Date.now() - started}ms)`,
  )

  await client.end()
  // Non-zero only if a template actually errored, so a scheduler alerts on real
  // failures and stays quiet on an ordinary "nothing was due" run.
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
