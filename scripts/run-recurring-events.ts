/**
 * Generate the next occurrence of every due recurring event series (M15 #8).
 *
 *   npm run events:recurring
 *
 * Deliberately the SAME script as scripts/run-recurring-expenses.ts, down to
 * the loop shape: select due templates in the TENANT's timezone, lock each one,
 * generate every missed period with `on conflict do nothing`, advance next_run
 * in SQL, commit. Two jobs of the same design behave the same way at 2am, and
 * one of them has already been in production.
 *
 * ── Why it is safe to run twice, or twice at once ───────────────────────────
 *
 * Not because it checks first — it does not. `idx_events_series_occurrence`
 * (migration 0090) is unique on (series_id, occurrence_period), so a duplicate
 * INSERT is refused by the database. A SELECT-then-INSERT has a window two
 * concurrent jobs can both pass through; a unique index has none. The row lock
 * below turns the race into a no-op rather than an error: whichever job gets
 * the lock second finds next_run already advanced and generates nothing.
 *
 * ── Timezone ────────────────────────────────────────────────────────────────
 *
 * There is no timezone arithmetic in JavaScript here. "Is it due?" is
 * `next_run <= (now() at time zone t.timezone)::date`, and the occurrence's
 * absolute instant is `(occurrence_period + start_time) at time zone
 * t.timezone` — both computed by Postgres from the tenant's own zone. A class
 * at 19:00 stays at 19:00 across a DST change because the stored value is a
 * wall-clock `time`, not an instant.
 *
 * Safe to interrupt: each series commits on its own, so a killed run resumes
 * from wherever it stopped.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

/**
 * How many missed periods one series may generate in a single run.
 *
 * A weekly class whose job has not run for a year would otherwise create 52
 * events in one go — almost certainly not what anybody wants to discover on a
 * Monday morning. The cap makes a long outage produce a bounded catch-up that
 * a manager can inspect, and the next run continues. Same ceiling, and the same
 * reasoning, as MAX_PERIODS_PER_TEMPLATE in run-recurring-expenses.ts.
 */
const MAX_PERIODS_PER_SERIES = 12

type DueSeries = {
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

  // Due = active AND next_run has arrived in the TENANT's timezone. A series
  // due on Tuesday must not fire while it is still Monday in Kolkata.
  const { rows: due } = await client.query<DueSeries>(`
    select s.id,
           s.tenant_id,
           s.next_run::text                            as next_run,
           (now() at time zone t.timezone)::date::text as today
      from public.event_series s
      join public.tenants t on t.id = s.tenant_id
     where s.is_active
       and s.next_run <= (now() at time zone t.timezone)::date
       and (s.until_date is null or s.next_run <= s.until_date)
     order by s.tenant_id, s.next_run
  `)

  console.log(`→ ${due.length} series due`)

  let generated = 0
  let skipped = 0
  let advanced = 0
  let failed = 0

  for (const s of due) {
    try {
      await client.query('begin')

      // Re-read under a row lock. A concurrent job holding it will have advanced
      // next_run by the time we get here, so the loop simply finds nothing due —
      // the lock turns a race into a no-op instead of a conflict.
      const { rows: locked } = await client.query<{
        next_run: string
        is_active: boolean
        until_date: string | null
        cadence: 'weekly' | 'monthly'
        day_of_month: number | null
      }>(
        `select next_run::text, is_active, until_date::text, cadence, day_of_month
           from public.event_series
          where id = $1
          for update`,
        [s.id],
      )
      const tpl = locked[0]
      if (!tpl || !tpl.is_active) {
        await client.query('rollback')
        continue
      }

      let cursor = tpl.next_run
      let made = 0
      let periods = 0

      // EVERY missed period is generated, not just the latest — a class that
      // should have run three Tuesdays running produces three occurrences, so
      // attendance and revenue reporting is not silently missing two weeks.
      while (
        cursor <= s.today &&
        (tpl.until_date === null || cursor <= tpl.until_date) &&
        periods < MAX_PERIODS_PER_SERIES
      ) {
        // The occurrence is an ORDINARY event, built entirely from the series
        // row inside the database — no field is round-tripped through this
        // script, so nothing here can substitute a value or cross a tenant.
        //
        // `on conflict do nothing` against idx_events_series_occurrence is the
        // idempotency guarantee.
        const { rowCount } = await client.query(
          `insert into public.events
             (tenant_id, branch_id, title, type, description, banner_url,
              starts_at, ends_at, capacity, entry_fee, tournament_format,
              registration_mode, team_size, status, created_by,
              series_id, occurrence_period)
           select s.tenant_id, s.branch_id, s.title, s.type, s.description, s.banner_url,
                  ($2::date + s.start_time) at time zone t.timezone,
                  ($2::date + s.start_time) at time zone t.timezone
                    + make_interval(mins => s.duration_minutes),
                  s.capacity, s.entry_fee, s.tournament_format,
                  s.registration_mode, s.team_size,
                  -- Generated OPEN for entries. A class nobody can book is not
                  -- a class; the manager can still cancel or draft it, and M15
                  -- #4's resource blocking picks it up from this status.
                  'registration_open'::public.event_status,
                  s.created_by,
                  s.id, $2::date
             from public.event_series s
             join public.tenants t on t.id = s.tenant_id
            where s.id = $1
           on conflict (series_id, occurrence_period) where series_id is not null
           do nothing`,
          [s.id, cursor],
        )

        if (rowCount && rowCount > 0) made++
        else skipped++

        // Advance the cursor in SQL. The month-end rule REUSES
        // recurring_expense_due_day() from 0042 — the function that already
        // decides a day-31 template lands on 28 February — rather than adding a
        // second implementation of the same clamp. Its name says "expense"
        // because that is where it was first needed; the arithmetic is the
        // calendar's, not the expense module's.
        const { rows: nxt } = await client.query<{ d: string }>(
          `select case
                    when $2::text = 'weekly' then ($1::date + 7)
                    else public.recurring_expense_due_day(
                           (date_trunc('month', $1::date) + interval '1 month')::date,
                           $3::smallint)
                  end::text as d`,
          [cursor, tpl.cadence, tpl.day_of_month],
        )
        cursor = nxt[0].d
        periods++
      }

      await client.query(`update public.event_series set next_run = $2::date where id = $1`, [
        s.id,
        cursor,
      ])

      await client.query('commit')
      generated += made
      advanced++
    } catch (e) {
      await client.query('rollback').catch(() => {})
      failed++
      console.error(
        `  ✗ series ${s.id}:`,
        e instanceof Error ? e.message : 'unknown error',
      )
    }
  }

  console.log(
    `✓ ${generated} occurrence(s) created, ${skipped} already existed, ` +
      `${advanced} series advanced, ${failed} failed (${Date.now() - started}ms)`,
  )

  await client.end()
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
