'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { eventSeries, eventSeriesSkips } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { todayInZone } from '@/lib/booking/time'
import { seriesStartError } from '@/lib/events/recurring'
import { resolveSeriesOptions } from '@/lib/events/series-options'
import { EventError, validateEventFields } from '@/lib/events/service'
import { EVENT_TYPES, TOURNAMENT_FORMATS, type TournamentFormat } from '@/lib/events/types'

/**
 * RECURRING EVENT SERIES — manager actions (M15 #8).
 *
 * ══ AUTHORIZATION ══════════════════════════════════════════════════════════
 *
 * Every export begins with `await requireManager()`, before parsing input.
 * `event_series_manager_write` (0136) is the database half, and RLS confines
 * every statement to the caller's own tenant — so a series id belonging to
 * another business is simply not found, whatever the browser sends.
 *
 * ══ THE SERIES DOES NOT CREATE EVENTS ══════════════════════════════════════
 *
 * Nothing here writes to `events`. A series is configuration; the occurrences
 * are produced by scripts/run-recurring-events.ts, whose idempotency comes from
 * a unique index rather than from anything this file does. Keeping generation
 * in the job means there is exactly one code path that creates an occurrence,
 * and it is the one that has the lock and the conflict clause.
 *
 * ══ DISABLING NEVER DELETES ════════════════════════════════════════════════
 *
 * `setSeriesActive(false)` stops FUTURE generation and touches no occurrence
 * that already exists — they took registrations and possibly money. Deleting a
 * series likewise leaves its events standing: `events_series_fk` is ON DELETE
 * SET NULL (0136), so an occurrence loses its provenance and keeps everything
 * else.
 */

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof EventError) return { error: e.message }
  // The plan does not include Tournaments & Events — a refusal about what the
  // business bought, not who is asking. Same shape as lib/actions/expenses.ts.
  if (e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  if (code === '23503') return { error: 'That venue no longer exists.' }
  if (code === '23514') {
    return { error: 'That combination is not valid — check the cadence, format and team size.' }
  }
  console.error('[event-series] failed:', e instanceof Error ? e.name : 'unknown error')
  return { error: 'Something went wrong. Please try again.' }
}

const seriesInput = z.object({
  id: z.string().uuid().optional(),
  branchId: z.string().uuid(),
  title: z.string().trim().min(1, 'A title is required.').max(120),
  type: z.enum(EVENT_TYPES as [string, ...string[]]),
  description: z.string().trim().max(2000).optional(),
  cadence: z.enum(['weekly', 'monthly']),
  /** 0 = Sunday … 6 = Saturday. Required for weekly. */
  weekday: z.coerce.number().int().min(0).max(6).nullable().optional(),
  /** 1–31, clamped to the month's end by the job. Required for monthly. */
  dayOfMonth: z.coerce.number().int().min(1).max(31).nullable().optional(),
  /** Local wall-clock `HH:MM`, in the tenant's timezone. */
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 19:00.'),
  durationMinutes: z.coerce.number().int().min(15).max(1440),
  /** The first local date to generate for. */
  nextRun: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-01.'),
  untilDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('')),
  capacity: z.coerce.number().int().min(1).nullable().optional(),
  entryFee: z.coerce.number().min(0),
  /** Omitted on an edit = keep the stored format; '' clears it. */
  tournamentFormat: z.enum(TOURNAMENT_FORMATS as [string, ...string[]]).optional().or(z.literal('')),
  /** Omitted on an edit = keep the stored mode; a new series defaults to solo. */
  registrationMode: z.enum(['solo', 'team']).optional(),
  teamSize: z.coerce.number().int().min(2).max(20).nullable().optional(),
  /**
   * What every generated occurrence reserves (0139). 'specific' is absent on
   * purpose — a template cannot name individual stations, because the ones it
   * named may not exist by the time an occurrence is generated. Mirrored by
   * event_series_resource_scope in the migration.
   */
  /** Omitted on an edit = keep the stored scope; a new series defaults to none. */
  resourceScope: z.enum(['none', 'branch']).optional(),
})

export async function upsertEventSeries(input: z.input<typeof seriesInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const v = seriesInput.parse(input)

    if (v.cadence === 'weekly' && (v.weekday === null || v.weekday === undefined)) {
      return { error: 'Choose which day of the week the series runs.' }
    }
    if (v.cadence === 'monthly' && (v.dayOfMonth === null || v.dayOfMonth === undefined)) {
      return { error: 'Choose which day of the month the series runs.' }
    }

    // On an edit, anything the caller did not send keeps its stored value — a form
    // that only knows some fields must not silently reset the rest (the station
    // scope above all: it would stop the series holding its courts).
    const existing = v.id
      ? (
          await withUser(ctx.user.id, (tx) =>
            tx
              .select({
                nextRun: eventSeries.nextRun,
                resourceScope: eventSeries.resourceScope,
                registrationMode: eventSeries.registrationMode,
                teamSize: eventSeries.teamSize,
                tournamentFormat: eventSeries.tournamentFormat,
              })
              .from(eventSeries)
              .where(and(eq(eventSeries.id, v.id as string), eq(eventSeries.tenantId, ctx.tenant.id)))
              .limit(1),
          )
        )[0]
      : undefined
    if (v.id && !existing) return { error: 'That series no longer exists.' }
    const { resourceScope, registrationMode, teamSize, tournamentFormat } = resolveSeriesOptions(
      { ...v, tournamentFormat: v.tournamentFormat as TournamentFormat | '' | undefined },
      existing,
    )

    // A series must start today or later, in the venue's own calendar — see
    // seriesStartError. An existing series may keep the next_run it already has.
    {
      const pastError = seriesStartError(v.nextRun, todayInZone(ctx.tenant.timezone), existing?.nextRun)
      if (pastError) return { error: pastError }
    }

    // The first occurrence must FALL ON the chosen day, because the job advances
    // weekly by adding seven days — it never snaps to a weekday. Without this
    // check a series configured as "Tuesdays" but started on a Wednesday would
    // generate every Wednesday while the UI said Tuesday, and nothing would ever
    // correct it. Cheap to refuse, impossible to notice later.
    if (v.cadence === 'weekly') {
      // Parsed as UTC deliberately: `nextRun` is a bare calendar date and
      // getUTCDay() reads it without dragging the server's zone into it.
      const dow = new Date(`${v.nextRun}T00:00:00Z`).getUTCDay()
      if (dow !== v.weekday) {
        const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        return {
          error: `${v.nextRun} is a ${names[dow]}, but the series runs on ${names[v.weekday as number]}s. Pick a ${names[v.weekday as number]} for the first occurrence.`,
        }
      }
    }
    // A monthly series needs no equivalent check: the job re-derives the day
    // from `day_of_month` on every advance (via recurring_expense_due_day), so
    // it self-corrects to the configured day and the month-end clamp.
    if (v.untilDate && v.untilDate < v.nextRun) {
      return { error: 'The end date is before the first occurrence.' }
    }

    // The SAME field rules an event itself must satisfy, applied to the
    // template — so a series cannot be configured to generate events the
    // `events` CHECKs would reject every night with nobody watching. Reused
    // from lib/events/lifecycle.ts rather than restated.
    const start = new Date(`${v.nextRun}T${v.startTime}:00Z`)
    const end = new Date(start.getTime() + v.durationMinutes * 60_000)
    const invalid = validateEventFields({
      type: v.type as (typeof EVENT_TYPES)[number],
      startsAt: start,
      endsAt: end,
      capacity: v.capacity ?? null,
      entryFee: v.entryFee,
      tournamentFormat,
      registrationMode,
      teamSize,
    })
    if (invalid) return { error: invalid }

    const values = {
      tenantId: ctx.tenant.id,
      branchId: v.branchId,
      cadence: v.cadence,
      weekday: v.cadence === 'weekly' ? (v.weekday as number) : null,
      dayOfMonth: v.cadence === 'monthly' ? (v.dayOfMonth as number) : null,
      startTime: v.startTime,
      durationMinutes: v.durationMinutes,
      nextRun: v.nextRun,
      untilDate: v.untilDate ? v.untilDate : null,
      title: v.title,
      type: v.type as (typeof EVENT_TYPES)[number],
      description: v.description ? v.description : null,
      capacity: v.capacity ?? null,
      entryFee: v.entryFee.toFixed(2),
      tournamentFormat,
      registrationMode,
      teamSize,
      resourceScope,
    }

    await withUser(ctx.user.id, async (tx) => {
      if (v.id) {
        // Editing a series changes what FUTURE occurrences look like. Nothing
        // touches an event already generated — see 0136's header.
        await tx
          .update(eventSeries)
          .set(values)
          .where(and(eq(eventSeries.id, v.id), eq(eventSeries.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(eventSeries).values({ ...values, createdBy: ctx.membershipId })
      }
    })

    revalidatePath('/settings/events')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Stop (or resume) future generation.
 *
 * The ticket's "disable without deleting history" requirement: this flips one
 * boolean the job reads, and the occurrences already generated are untouched.
 */
export async function setEventSeriesActive(seriesId: string, active: boolean): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const id = z.string().uuid().parse(seriesId)
    const isActive = z.boolean().parse(active)

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(eventSeries)
        .set({ isActive })
        .where(and(eq(eventSeries.id, id), eq(eventSeries.tenantId, ctx.tenant.id))),
    )

    revalidatePath('/settings/events')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Delete a series.
 *
 * `events_series_fk` is ON DELETE SET NULL (0136), so every occurrence it
 * produced survives — it simply stops naming its origin. Historical events,
 * their registrations and their money are never destroyed by a template change.
 */
export async function deleteEventSeries(seriesId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const id = z.string().uuid().parse(seriesId)

    await withUser(ctx.user.id, (tx) =>
      tx
        .delete(eventSeries)
        .where(and(eq(eventSeries.id, id), eq(eventSeries.tenantId, ctx.tenant.id))),
    )

    revalidatePath('/settings/events')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Resolve a skipped occurrence by creating it anyway.
 *
 * The job skipped it because its stations were already booked. Creating it here
 * makes the event (open for registration, like any generated occurrence) WITHOUT
 * holding stations — the manager sorts the stations out on the event itself. A
 * period that has already ended is refused; the skip row is removed on success.
 */
export async function createSkippedOccurrence(skipId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const id = z.string().uuid().parse(skipId)

    const outcome = await withUser(ctx.user.id, async (tx) => {
      const [skip] = await tx
        .select({ seriesId: eventSeriesSkips.seriesId, period: eventSeriesSkips.occurrencePeriod })
        .from(eventSeriesSkips)
        .where(and(eq(eventSeriesSkips.id, id), eq(eventSeriesSkips.tenantId, ctx.tenant.id)))
        .for('update')
      if (!skip) return 'gone' as const

      const inserted = await tx.execute(sql`
        insert into public.events
          (tenant_id, branch_id, title, type, description, banner_url, resource_scope,
           starts_at, ends_at, capacity, entry_fee, tournament_format,
           registration_mode, team_size, status, created_by, series_id, occurrence_period)
        select s.tenant_id, s.branch_id, s.title, s.type, s.description, s.banner_url, 'none',
               (${skip.period}::date + s.start_time) at time zone t.timezone,
               (${skip.period}::date + s.start_time) at time zone t.timezone
                 + make_interval(mins => s.duration_minutes),
               s.capacity, s.entry_fee, s.tournament_format,
               s.registration_mode, s.team_size,
               'registration_open'::public.event_status, s.created_by, s.id, ${skip.period}::date
          from public.event_series s
          join public.tenants t on t.id = s.tenant_id
         where s.id = ${skip.seriesId}
           and s.tenant_id = ${ctx.tenant.id}
           and (${skip.period}::date + s.start_time) at time zone t.timezone
                 + make_interval(mins => s.duration_minutes) > now()
        on conflict (series_id, occurrence_period) where series_id is not null do nothing
        returning id
      `)
      const created = (inserted.rows?.length ?? 0) > 0
      if (!created) {
        // Either it already exists (resolved elsewhere) or its window has passed.
        const [exists] = (
          await tx.execute(sql`
            select 1 from public.events where series_id = ${skip.seriesId} and occurrence_period = ${skip.period}::date
          `)
        ).rows
        if (!exists) return 'past' as const
      }
      await tx.delete(eventSeriesSkips).where(eq(eventSeriesSkips.id, id))
      return 'ok' as const
    })

    if (outcome === 'gone') return { error: 'That skipped occurrence was already resolved.' }
    if (outcome === 'past') return { error: 'That occurrence has already ended, so it cannot be created. Dismiss it instead.' }
    revalidatePath('/settings/events')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Dismiss a skipped occurrence without creating it. */
export async function dismissSkippedOccurrence(skipId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const id = z.string().uuid().parse(skipId)
    await withUser(ctx.user.id, (tx) =>
      tx
        .delete(eventSeriesSkips)
        .where(and(eq(eventSeriesSkips.id, id), eq(eventSeriesSkips.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/events')
    return {}
  } catch (e) {
    return fail(e)
  }
}
