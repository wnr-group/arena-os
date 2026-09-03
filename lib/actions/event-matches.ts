'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { EventError } from '@/lib/events/lifecycle'
import {
  generateEventBracket,
  recordMatchResult,
  resetEventBracket,
} from '@/lib/events/bracket-service'

/**
 * BRACKET AND SCORE-ENTRY ACTIONS (M15 #6).
 *
 * ══ AUTHORIZATION ══════════════════════════════════════════════════════════
 *
 * Every export begins with `await requireManager()`, before it parses input and
 * before it touches anything. A server action is a public POST endpoint, so a
 * cashier, a customer or an unauthenticated caller reaching any of these gets
 * an AuthError and nothing happens. `event_matches_manager_write` (0086) is the
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
