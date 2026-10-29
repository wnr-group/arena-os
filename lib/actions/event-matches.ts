'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { EventError } from '@/lib/events/lifecycle'
import {
  correctMatchResult,
  forfeitMatch,
  generateEventBracket,
  recordMatchResult,
  reopenMatch,
  resetEventBracket,
  voidMatch,
} from '@/lib/events/bracket-service'
import { liveTag } from '@/lib/events/public-live-cache'

/**
 * BRACKET AND SCORE-ENTRY ACTIONS (M15 #6).
 *
 * ══ AUTHORIZATION ══════════════════════════════════════════════════════════
 *
 * Every export begins with `await requireManager()`, before it parses input and
 * before it touches anything. A server action is a public POST endpoint, so a
 * cashier, a customer or an unauthenticated caller reaching any of these gets
 * an AuthError and nothing happens. `event_matches_manager_write` (0134) is the
 * database half of the same rule, and RLS confines every statement to the
 * caller's own tenant regardless of what id was supplied.
 *
 * ══ WHAT IS TRUSTED FROM THE CALLER ════════════════════════════════════════
 *
 * An event id, a match id and two numbers. Nothing else — and specifically NOT
 * the winner. The client cannot submit `winner = A`; it submits two scores and
 * decideWinner() in the pure engine derives the result server-side. The tenant
 * is taken from the session, and both ids are re-read under it, so a match
 * belonging to another business is simply not found.
 */

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof EventError) return { error: e.message }
  // The plan does not include Tournaments & Events — a refusal about what the
  // business bought, not who is asking. Same shape as lib/actions/expenses.ts.
  if (e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  // 23505 = the coordinate unique index: two generations raced and this one
  // lost. The draw exists; saying so is more useful than a constraint name.
  if (code === '23505') {
    return { error: 'A bracket already exists for this event. Refresh to see it.' }
  }
  if (code === '23503') return { error: 'That event or participant no longer exists.' }
  console.error('[event-matches] failed:', e instanceof Error ? e.name : 'unknown error')
  return { error: 'Something went wrong. Please try again.' }
}

function revalidateBracket(eventId: string): void {
  revalidatePath(`/settings/events/${eventId}`)
  revalidatePath(`/settings/events/${eventId}/bracket`)
  // The public live page is cached for a few seconds; a staff change should be
  // visible to spectators on their next poll, not after the cache lapses.
  updateTag(liveTag(eventId))
}

// ── generation ───────────────────────────────────────────────────────────────

export type GenerateBracketResult = Result & {
  format?: string
  participants?: number
  matches?: number
}

/**
 * Draw the bracket from the checked-in list.
 *
 * The whole operation — lock, duplicate check, participant read, generation and
 * insert — is ONE transaction, so a failure part-way leaves no partial draw.
 */
export async function generateBracketAction(eventId: string): Promise<GenerateBracketResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const id = z.string().uuid().parse(eventId)

    const result = await withUser(ctx.user.id, (tx) => generateEventBracket(tx, ctx, id))

    revalidateBracket(id)
    return result
  } catch (e) {
    return fail(e)
  }
}

export type ResetBracketResult = Result & { removed?: number }

/**
 * Discard an unplayed draw so it can be redrawn.
 *
 * Explicitly separate from generation — the ticket requires regeneration to be
 * a deliberate, authorized act rather than something a page load can trigger —
 * and it refuses outright once any result has been entered.
 */
export async function resetBracketAction(eventId: string): Promise<ResetBracketResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const id = z.string().uuid().parse(eventId)

    const removed = await withUser(ctx.user.id, (tx) => resetEventBracket(tx, ctx, id))

    revalidateBracket(id)
    return { removed }
  } catch (e) {
    return fail(e)
  }
}

// ── score entry ──────────────────────────────────────────────────────────────

const resultInput = z.object({
  matchId: z.string().uuid(),
  eventId: z.string().uuid(),
  /**
   * Scores only. There is deliberately NO `winner` field: accepting one would
   * let a caller declare a victor that the score does not support, which is
   * precisely what §8 forbids. The server derives it.
   */
  scoreA: z.coerce.number().int('Scores must be whole numbers.').min(0, 'Scores cannot be negative.'),
  scoreB: z.coerce
    .number()
    .int('Scores must be whole numbers.')
    .min(0, 'Scores cannot be negative.')
    .nullable()
    .optional(),
})

export type RecordResultActionResult = Result & {
  winner?: string | null
  advanced?: boolean
}

/**
 * Enter a match result. The winner is derived from the scores, the match is
 * completed, and the winner (and, in double elimination, the loser) are placed
 * into their stored next slots — all atomically.
 */
export async function recordMatchResultAction(
  input: z.input<typeof resultInput>,
): Promise<RecordResultActionResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const v = resultInput.parse(input)

    const outcome = await withUser(ctx.user.id, (tx) =>
      recordMatchResult(tx, ctx, {
        matchId: v.matchId,
        scoreA: v.scoreA,
        scoreB: v.scoreB ?? null,
      }),
    )

    revalidateBracket(v.eventId)
    return { winner: outcome.winner, advanced: outcome.advancedTo !== null }
  } catch (e) {
    return fail(e)
  }
}

// ── corrections ──────────────────────────────────────────────────────────────

const correctInput = resultInput.extend({
  /** Also reset later matches that were played on the strength of the old result. */
  cascade: z.boolean().optional(),
})

export type CorrectionResult = Result & { winner?: string | null; unwound?: number }

/**
 * Replace a recorded result. A changed score with the same winner touches
 * nothing else; a changed winner takes the old outcome back out of the later
 * matches and places the new one, refusing if those were played unless
 * `cascade` is set.
 */
export async function correctMatchResultAction(
  input: z.input<typeof correctInput>,
): Promise<CorrectionResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const v = correctInput.parse(input)

    const out = await withUser(ctx.user.id, (tx) =>
      correctMatchResult(tx, ctx, {
        matchId: v.matchId,
        scoreA: v.scoreA,
        scoreB: v.scoreB ?? null,
        cascade: v.cascade,
      }),
    )
    revalidateBracket(v.eventId)
    return { winner: out.winner, unwound: out.unwound ?? 0 }
  } catch (e) {
    return fail(e)
  }
}

const matchRef = z.object({
  matchId: z.string().uuid(),
  eventId: z.string().uuid(),
  cascade: z.boolean().optional(),
})

/** Award a match to one side because the other did not play. */
export async function forfeitMatchAction(
  input: z.input<typeof matchRef> & { forfeitingSide: 'a' | 'b' },
): Promise<CorrectionResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const v = matchRef.extend({ forfeitingSide: z.enum(['a', 'b']) }).parse(input)
    const out = await withUser(ctx.user.id, (tx) =>
      forfeitMatch(tx, ctx, { matchId: v.matchId, forfeitingSide: v.forfeitingSide, cascade: v.cascade }),
    )
    revalidateBracket(v.eventId)
    return { winner: out.winner, unwound: out.unwound ?? 0 }
  } catch (e) {
    return fail(e)
  }
}

/** Drop a round-robin fixture that will not be played. */
export async function voidMatchAction(input: z.input<typeof matchRef>): Promise<CorrectionResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const v = matchRef.parse(input)
    await withUser(ctx.user.id, (tx) => voidMatch(tx, ctx, { matchId: v.matchId, cascade: v.cascade }))
    revalidateBracket(v.eventId)
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Undo a result so the match can be scored again. */
export async function reopenMatchAction(input: z.input<typeof matchRef>): Promise<CorrectionResult> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.events')
    const v = matchRef.parse(input)
    const out = await withUser(ctx.user.id, (tx) =>
      reopenMatch(tx, ctx, { matchId: v.matchId, cascade: v.cascade }),
    )
    revalidateBracket(v.eventId)
    return { unwound: out.unwound ?? 0 }
  } catch (e) {
    return fail(e)
  }
}
