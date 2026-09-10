'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { eventSeries } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { EventError, validateEventFields } from '@/lib/events/service'
import { EVENT_TYPES, TOURNAMENT_FORMATS } from '@/lib/events/types'

/**
 * RECURRING EVENT SERIES — manager actions (M15 #8).
 *
 * ══ AUTHORIZATION ══════════════════════════════════════════════════════════
 *
 * Every export begins with `await requireManager()`, before parsing input.
 * `event_series_manager_write` (0100) is the database half, and RLS confines
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
 * SET NULL (0100), so an occurrence loses its provenance and keeps everything
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
  tournamentFormat: z.enum(TOURNAMENT_FORMATS as [string, ...string[]]).optional().or(z.literal('')),
  registrationMode: z.enum(['solo', 'team']).default('solo'),
  teamSize: z.coerce.number().int().min(2).max(20).nullable().optional(),
  /**
   * What every generated occurrence reserves (0103). 'specific' is absent on
   * purpose — a template cannot name individual stations, because the ones it
   * named may not exist by the time an occurrence is generated. Mirrored by
   * event_series_resource_scope in the migration.
   */
  resourceScope: z.enum(['none', 'branch']).default('none'),
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
      tournamentFormat: (v.tournamentFormat || null) as (typeof TOURNAMENT_FORMATS)[number] | null,
      registrationMode: v.registrationMode,
      teamSize: v.registrationMode === 'team' ? (v.teamSize ?? null) : null,
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
      tournamentFormat: (v.tournamentFormat || null) as (typeof TOURNAMENT_FORMATS)[number] | null,
      registrationMode: v.registrationMode,
      teamSize: v.registrationMode === 'team' ? (v.teamSize ?? null) : null,
      resourceScope: v.resourceScope,
    }

    await withUser(ctx.user.id, async (tx) => {
      if (v.id) {
        // Editing a series changes what FUTURE occurrences look like. Nothing
        // touches an event already generated — see 0100's header.
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
 * `events_series_fk` is ON DELETE SET NULL (0100), so every occurrence it
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
