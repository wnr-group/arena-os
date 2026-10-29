/**
 * Generate the upcoming occurrences of every recurring event series (M15 #8).
 *
 * Shared by scripts/run-recurring-events.ts (`npm run events:recurring`) and the
 * scheduled route app/api/cron/generate-events, so the two can never drift.
 * Deliberately the same loop shape as scripts/run-recurring-expenses.ts: select
 * due templates in the TENANT's timezone, lock each one, generate every period
 * in the window with `on conflict do nothing`, advance next_run in SQL, commit.
 *
 * ── Why it is safe to run twice, or twice at once ───────────────────────────
 *
 * Not because it checks first — it does not. `idx_events_series_occurrence`
 * (migration 0136) is unique on (series_id, occurrence_period), so a duplicate
 * INSERT is refused by the database. The row lock turns the race into a no-op:
 * whichever job gets the lock second finds next_run already advanced.
 *
 * ── Lead time ───────────────────────────────────────────────────────────────
 *
 * An occurrence is generated GENERATE_AHEAD_DAYS before it happens, not on the
 * day: it is created open for registration, so customers need a window to
 * register in, and a conflict with an existing booking is found while a manager
 * can still move things.
 *
 * ── A conflict skips ONE occurrence, never the series ───────────────────────
 *
 * If the occurrence's resource blocks collide with a booking already in that
 * window, that occurrence is rolled back to a savepoint and recorded in
 * event_series_skips (0164) for a manager to see; the cursor still advances. The
 * old behaviour — rolling the whole series back — left next_run on the head
 * period forever, so one conflicting Tuesday stopped every later Tuesday too.
 *
 * ── A finished period is never generated ────────────────────────────────────
 *
 * After an outage the cursor can be weeks behind. A period whose occurrence has
 * already ENDED is stepped over (counted in `pastSkipped`), not minted: it would
 * be open for registration and would try to hold stations in the past.
 *
 * ── Timezone ────────────────────────────────────────────────────────────────
 *
 * No timezone arithmetic in JavaScript. "Is it due?" is computed by Postgres from
 * the tenant's own zone, and the occurrence's instant is
 * `(occurrence_period + start_time) at time zone t.timezone`. A class at 19:00
 * stays at 19:00 across a DST change.
 *
 * Safe to interrupt: each series commits on its own.
 */
import type { Client } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/db/schema'
import { EventError } from './lifecycle'
import { syncEventBlocks } from './resource-blocks'

/** How far ahead of the day an occurrence is generated (and opened for entries). */
export const GENERATE_AHEAD_DAYS = 14

/**
 * How many periods one series may generate in a single run.
 *
 * A weekly class whose job has not run for a year would otherwise create 52
 * events in one go. The cap makes a long outage produce a bounded catch-up that
 * a manager can inspect; the next run continues. Same ceiling as
 * MAX_PERIODS_PER_TEMPLATE in run-recurring-expenses.ts.
 */
export const MAX_PERIODS_PER_SERIES = 12

/**
 * Why a series may not start on `nextRun`, or null when it may. A start before
 * the venue's today would mint a run of finished events that are open for
 * entries and hold stations in the past. An existing series keeps the next_run
 * it already has (the job advances it); only a CHANGE to a past date is refused.
 */
export function seriesStartError(nextRun: string, today: string, storedNextRun?: string | null): string | null {
  if (nextRun >= today || nextRun === storedNextRun) return null
  return 'The first occurrence cannot be in the past. Pick today or a later date.'
}

type DueSeries = {
  id: string
  tenant_id: string
  next_run: string
  /** Last local date to generate for in this run: the tenant's today + the lead. */
  horizon: string
}

export type RecurringRunSummary = {
  due: number
  generated: number
  alreadyExisted: number
  /** Occurrences not created because their resources were already booked. */
  conflicted: number
  advanced: number
  /** Periods stepped over because the occurrence had already ended. */
  pastSkipped: number
  failed: number
  /** Why each failed series failed — surfaced by the route, not only console.error. */
  failures: { seriesId: string; reason: string }[]
}

/** A resource clash while holding an occurrence's stations: the booking_slots
 *  exclusion constraint (23P01), or the named-conflict check in syncEventBlocks. */
function isBlockConflict(e: unknown): boolean {
  return e instanceof EventError || (e as { code?: string }).code === '23P01'
}

export async function runRecurringEvents(
  client: Client,
  opts: { aheadDays?: number; log?: (line: string) => void } = {},
): Promise<RecurringRunSummary> {
  const ahead = opts.aheadDays ?? GENERATE_AHEAD_DAYS
  const log = opts.log ?? (() => {})

  // A Drizzle handle over THIS SAME client — not a second connection.
  //
  // syncEventBlocks() is Drizzle-shaped, and wrapping the very client that
  // holds the open transaction puts its writes INSIDE that transaction. The
  // occurrence and the booking_slots it reserves therefore commit together or
  // not at all. A separate pool could not see this transaction's uncommitted
  // event row.
  const db = drizzle(client, { schema })

  // Due = active AND next_run falls inside the window [.., tenant today + lead].
  const { rows: due } = await client.query<DueSeries>(
    `select s.id,
            s.tenant_id,
            s.next_run::text                                       as next_run,
            ((now() at time zone t.timezone)::date + $1::int)::text as horizon
       from public.event_series s
       join public.tenants t on t.id = s.tenant_id
      where s.is_active
        and s.next_run <= (now() at time zone t.timezone)::date + $1::int
        and (s.until_date is null or s.next_run <= s.until_date)
      order by s.tenant_id, s.next_run`,
    [ahead],
  )

  log(`→ ${due.length} series due`)

  const summary: RecurringRunSummary = {
    due: due.length,
    generated: 0,
    alreadyExisted: 0,
    conflicted: 0,
    advanced: 0,
    pastSkipped: 0,
    failed: 0,
    failures: [],
  }

  for (const s of due) {
    try {
      await client.query('begin')

      // Re-read under a row lock. A concurrent job holding it will have advanced
      // next_run by the time we get here, so the loop simply finds nothing due.
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
      let existed = 0
      let conflicted = 0
      let past = 0
      let periods = 0

      // EVERY period in the window is handled, not just the latest — a class
      // that should have run three Tuesdays running produces three occurrences,
      // so attendance and revenue reporting is not silently missing two weeks.
      while (
        cursor <= s.horizon &&
        (tpl.until_date === null || cursor <= tpl.until_date) &&
        periods < MAX_PERIODS_PER_SERIES
      ) {
        // Already over? Step past it — never mint a finished occurrence open for
        // registration, and never try to block a window that has gone by.
        const { rows: ended } = await client.query<{ over: boolean }>(
          `select (($2::date + s.start_time) at time zone t.timezone
                      + make_interval(mins => s.duration_minutes)) < now() as over
             from public.event_series s
             join public.tenants t on t.id = s.tenant_id
            where s.id = $1`,
          [s.id, cursor],
        )
        const isPast = ended[0]?.over === true

        // Each occurrence in its own savepoint: a clash rolls back THIS one only.
        await client.query('savepoint occurrence')
        try {
          if (isPast) {
            past++
            await client.query('release savepoint occurrence')
          } else {
            // The occurrence is an ORDINARY event, built entirely from the series
            // row inside the database — no field is round-tripped through this
            // code, so nothing here can substitute a value or cross a tenant.
            // `on conflict do nothing` against idx_events_series_occurrence is the
            // idempotency guarantee.
            const { rowCount, rows: made_ } = await client.query<{ id: string }>(
              `insert into public.events
                 (tenant_id, branch_id, title, type, description, banner_url, resource_scope,
                  starts_at, ends_at, capacity, entry_fee, tournament_format,
                  registration_mode, team_size, status, created_by,
                  series_id, occurrence_period)
               select s.tenant_id, s.branch_id, s.title, s.type, s.description, s.banner_url, s.resource_scope,
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
               do nothing
               returning id`,
              [s.id, cursor],
            )

            if (rowCount && rowCount > 0) {
              // The occurrence RESERVES what the series says it reserves — the SAME
              // syncEventBlocks() the settings screen calls, with the booking_slots
              // exclusion constraint (0003/0130) as the real arbiter.
              await syncEventBlocks(db as never, s.tenant_id, made_[0].id)
              made++
            } else existed++
            await client.query('release savepoint occurrence')
          }
        } catch (e) {
          if (!isBlockConflict(e)) throw e
          // Undo the event row and anything syncEventBlocks wrote for it, keep
          // the rest of the series' work, and leave a record a manager can read.
          await client.query('rollback to savepoint occurrence')
          await client.query('release savepoint occurrence')
          await client.query(
            `insert into public.event_series_skips (tenant_id, series_id, occurrence_period, reason)
             values ($1, $2, $3::date, $4)
             on conflict (series_id, occurrence_period)
             do update set reason = excluded.reason, created_at = now()`,
            [s.tenant_id, s.id, cursor, e instanceof Error ? e.message.slice(0, 500) : 'Resources already booked.'],
          )
          conflicted++
        }

        // Advance the cursor in SQL. The month-end rule REUSES
        // recurring_expense_due_day() from 0042 — the function that already
        // decides a day-31 template lands on 28 February — rather than adding a
        // second implementation of the same clamp.
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
      summary.generated += made
      summary.alreadyExisted += existed
      summary.conflicted += conflicted
      summary.pastSkipped += past
      // Only a run that actually moved the cursor counts: a concurrent job may
      // already have advanced this series while we waited on the row lock.
      if (cursor !== tpl.next_run) summary.advanced++
    } catch (e) {
      await client.query('rollback').catch(() => {})
      summary.failed++
      const reason = e instanceof Error ? e.message.slice(0, 300) : 'unknown error'
      summary.failures.push({ seriesId: s.id, reason })
      console.error(`  ✗ series ${s.id}:`, reason)
    }
  }

  return summary
}
