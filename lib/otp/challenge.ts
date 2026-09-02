import 'server-only'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * The `customer_otp_challenges` row lifecycle.
 *
 * Every rule that makes an OTP safe — one send per cooldown, five attempts,
 * five minutes, single use — is enforced by a SQL statement here rather than by
 * an `if` in application code. That is deliberate: read-then-write in
 * JavaScript is exactly the shape that two concurrent requests slip through,
 * and an OTP check is precisely where somebody will aim concurrency.
 *
 * All of these run inside a withPublicTenant() transaction, so RLS
 * (0044_customer_auth.sql) confines them to the one tenant the subdomain
 * resolved to — a tenant can neither read nor write another tenant's
 * challenges even if a bug here forgot the tenant_id predicate.
 */

/** OTP validity. Long enough for a slow SMS, short enough to be worth little. */
export const OTP_TTL_SECONDS = 5 * 60

/**
 * Wrong guesses allowed per challenge. Five leaves 5 chances in 1,000,000 —
 * about 1 in 200,000 — of hitting a 6-digit code by guessing.
 */
export const OTP_MAX_ATTEMPTS = 5

/** Minimum gap between two sends to the same phone on the same tenant. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60

export type CreateChallengeInput = {
  id: string
  tenantId: string
  phone: string
  codeHash: string
}

export type CreateChallengeResult =
  | { ok: true }
  | { ok: false; reason: 'cooldown'; retryAfterSeconds: number }

/**
 * Write a new challenge, unless a live one for this (tenant, phone) is still
 * inside its resend cooldown.
 *
 * The guard is a `where not exists` on the INSERT itself, not a separate SELECT
 * followed by an insert: two simultaneous "resend" clicks would both pass a
 * read-then-write check and send two SMS. As one statement, at most one of them
 * inserts a row and the other gets zero rows back.
 *
 * This is the DURABLE half of the send limit. The in-memory limiter in
 * lib/security/rate-limit.ts is the fast half, but it is per-process and resets
 * on deploy (its own comment says so), so it cannot be the only thing standing
 * between an attacker and an unbounded SMS bill.
 */
export async function createChallenge(
  tx: Db,
  input: CreateChallengeInput,
): Promise<CreateChallengeResult> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    insert into public.customer_otp_challenges (id, tenant_id, phone, code_hash, expires_at)
    select
      ${input.id}::uuid,
      ${input.tenantId}::uuid,
      ${input.phone},
      ${input.codeHash},
      now() + make_interval(secs => ${OTP_TTL_SECONDS})
    where not exists (
      select 1 from public.customer_otp_challenges
       where tenant_id = ${input.tenantId}::uuid
         and phone = ${input.phone}
         and consumed_at is null
         and created_at > now() - make_interval(secs => ${OTP_RESEND_COOLDOWN_SECONDS})
    )
    returning id
  `)

  if (rows.length > 0) return { ok: true }

  const { rows: waitRows } = await tx.execute<{ retry_after: number }>(sql`
    select ceil(extract(epoch from (
             max(created_at) + make_interval(secs => ${OTP_RESEND_COOLDOWN_SECONDS}) - now()
           )))::int as retry_after
      from public.customer_otp_challenges
     where tenant_id = ${input.tenantId}::uuid
       and phone = ${input.phone}
       and consumed_at is null
  `)

  return {
    ok: false,
    reason: 'cooldown',
    retryAfterSeconds: Math.max(1, Number(waitRows[0]?.retry_after ?? OTP_RESEND_COOLDOWN_SECONDS)),
  }
}

/**
 * Kill a challenge we just created but could not deliver.
 *
 * The row is EXPIRED, not consumed, and not deleted. Each of those three is a
 * deliberate choice and the difference between them is the whole point:
 *
 *   deleted   — claimAttempt() would find nothing, but so would the cooldown
 *               guard, so a gateway that fails on every call would let the app
 *               hammer it once per request. Also loses the evidence.
 *
 *   consumed  — what this used to do, and it had exactly the same hole.
 *               createChallenge()'s guard counts only rows with
 *               `consumed_at is null`, so marking the row consumed took it
 *               straight back out of the cooldown window it was supposed to
 *               hold. The comment here claimed the opposite for a while; the
 *               test that was meant to catch it only asserted the row still
 *               existed, which it did.
 *
 *   expired   — claimAttempt() requires `expires_at > now()`, so the code can
 *               never be presented again (a delivery we recorded as failed but
 *               which the gateway actually completed must not leave a usable
 *               code standing), while `consumed_at` stays NULL so the row goes
 *               on occupying the resend cooldown for the rest of its 60s.
 *
 * So a delivery failure costs the caller the same wait as a successful send,
 * and neither the gateway nor the challenge table can be driven in a loop.
 * pruneExpiredChallenges() clears these out a day later like any other expiry.
 *
 * A SUCCESSFUL login still sets `consumed_at` (consumeChallenge) and therefore
 * still releases the cooldown immediately — signing out and back in must not
 * make anyone wait a minute. Those are genuinely different cases, and using two
 * different columns is what lets them stay different.
 */
export async function voidChallenge(tx: Db, id: string): Promise<void> {
  await tx.execute(sql`
    update public.customer_otp_challenges
       set expires_at = now()
     where id = ${id}::uuid
       and consumed_at is null
       and expires_at > now()
  `)
}

export type ClaimedChallenge = { id: string; codeHash: string; attempts: number }

/**
 * Atomically spend one attempt against the newest live challenge for
 * (tenant, phone), returning the row to check the code against — or null when
 * there is nothing live to check (none exists, expired, already used, or the
 * attempt limit is spent).
 *
 * The single UPDATE is the whole point. The attempt is counted BEFORE the code
 * is compared, so a wrong guess costs one whether or not the caller sticks
 * around for the answer; and the row is locked for the rest of the transaction,
 * so a concurrent verify blocks here rather than racing us to consume it.
 *
 * The eligibility predicates are repeated on the outer UPDATE, not just in the
 * sub-select. Under READ COMMITTED a blocked UPDATE re-evaluates only its own
 * WHERE clause against the newly committed row: without the repetition, a
 * request that queued behind a successful verification would happily increment
 * a challenge that had just been consumed.
 */
export async function claimAttempt(
  tx: Db,
  tenantId: string,
  phone: string,
): Promise<ClaimedChallenge | null> {
  const { rows } = await tx.execute<{ id: string; code_hash: string; attempts: number }>(sql`
    update public.customer_otp_challenges
       set attempts = attempts + 1
     where id = (
             select id from public.customer_otp_challenges
              where tenant_id = ${tenantId}::uuid
                and phone = ${phone}
                and consumed_at is null
                and expires_at > now()
                and attempts < ${OTP_MAX_ATTEMPTS}
              order by created_at desc
              limit 1
           )
       and consumed_at is null
       and expires_at > now()
       and attempts < ${OTP_MAX_ATTEMPTS}
    returning id, code_hash, attempts
  `)

  const row = rows[0]
  return row ? { id: row.id, codeHash: row.code_hash, attempts: Number(row.attempts) } : null
}

/**
 * Burn the challenge. Returns false when someone else already burned it, which
 * is what stops two concurrent requests with the same correct code from both
 * being treated as a successful login.
 *
 * Safe because claimAttempt() already took a row lock in this transaction: a
 * competing request is either still blocked behind us or will find
 * `consumed_at` set when it unblocks.
 */
export async function consumeChallenge(tx: Db, id: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    update public.customer_otp_challenges
       set consumed_at = now()
     where id = ${id}::uuid and consumed_at is null
    returning id
  `)
  return rows.length > 0
}

/**
 * Drop challenges that are long dead. Called opportunistically on the send
 * path; the grace period keeps recently-expired rows around so they still hold
 * their resend cooldown.
 */
export async function pruneExpiredChallenges(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`
    delete from public.customer_otp_challenges
     where tenant_id = ${tenantId}::uuid
       and expires_at < now() - interval '1 day'
  `)
}
