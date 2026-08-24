'use server'

import { randomUUID } from 'node:crypto'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { withPublicTenant } from '@/db'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { normalizePhone } from '@/lib/customers/phone'
import { findOrCreateCustomer } from '@/lib/customers/service'
import { createCustomerSession, destroyCustomerSession } from '@/lib/auth/customer-session'
import { CUSTOMER_LOGIN_PATH } from '@/lib/auth/customer-guard'
import { getOtpProvider } from '@/lib/otp/provider'
import { hashOtpCode, isValidOtpCodeFormat } from '@/lib/otp/code'
import {
  createChallenge,
  claimAttempt,
  consumeChallenge,
  voidChallenge,
  pruneExpiredChallenges,
  OTP_TTL_SECONDS,
} from '@/lib/otp/challenge'
import { isOtpBypassActive } from '@/lib/otp/config'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'

/**
 * Customer phone/OTP login (AROS-87) — the entry point to the customer portal.
 *
 * Runs entirely on the PUBLIC request path: a customer logging in has no
 * session of any kind yet, so the tenant comes from the subdomain via
 * getPublicTenantBySlug() and every database call goes through
 * withPublicTenant(), never withUser(). Staff tenant resolution is not
 * reachable from here and must not be — a customer is not a member.
 *
 * ── Two rules that shape everything below ───────────────────────────────────
 *
 * 1. NO ENUMERATION. sendOtp() answers identically for a number that has booked
 *    fifty times and one that has never been seen. It never looks the customer
 *    up at all; the customer row is found-or-created only after a code is
 *    proven, in verifyOtp(). Any "no account for that number" response would
 *    turn this endpoint into a customer-list oracle for anyone on the internet
 *    — exactly the leak lookupPublicCustomerByPhone() in
 *    lib/actions/public-booking.ts is written to avoid.
 *
 * 2. ONE GENERIC FAILURE. Wrong code, expired code, already-used code and
 *    attempts-exhausted all return the same sentence. Distinguishing them tells
 *    a guesser which of their assumptions was right.
 */

type Fail = { error: string }

const GENERIC_CODE_ERROR = 'That code is incorrect or has expired. Request a new one to continue.'
const RATE_LIMIT_MESSAGE = 'Too many attempts. Please wait a moment and try again.'

async function callerIp(): Promise<string> {
  return ipFromHeaders(await headers())
}

/** The tenant this subdomain names, or an error. Never a staff-scoped lookup. */
async function resolvePublicTenant(): Promise<{ id: string } | Fail> {
  const slug = await currentTenantSlug()
  if (!slug) return { error: 'Unknown venue.' }
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) return { error: 'Unknown venue.' }
  return tenant
}

// ── send ─────────────────────────────────────────────────────────────────────

const sendInput = z.object({
  phone: z.string().trim().min(6, 'Enter a valid phone number.').max(20),
})

export type SendOtpResult = {
  ok?: true
  error?: string
  /** Present on a cooldown refusal so the UI can show a countdown. */
  retryAfterSeconds?: number
  /** How long the delivered code stays valid, for the UI's timer. */
  expiresInSeconds?: number
}

/**
 * Step 1: issue a code and text it to the number.
 *
 * The code is generated and hashed BEFORE the SMS goes out, so a delivery that
 * succeeds while our write fails can never leave a live code with nothing to
 * check it against. If delivery then fails, the challenge is voided — but it
 * stays on the resend cooldown, so a gateway outage cannot be turned into a
 * loop that hammers the gateway once per request.
 */
export async function sendOtp(raw: z.input<typeof sendInput>): Promise<SendOtpResult> {
  const ip = await callerIp()
  // Coarse per-IP gate first: it costs nothing and stops a single host from
  // walking phone numbers before any parsing or database work happens.
  if (!rateLimit(`otp:send:ip:${ip}`, 10, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const parsed = sendInput.safeParse(raw)
  if (!parsed.success) return { error: 'Enter a valid phone number.' }

  const phone = normalizePhone(parsed.data.phone)
  if (!phone) return { error: 'Enter a valid phone number.' }

  // Per (tenant, phone), not per phone globally: the same person is a separate
  // customer at each venue (the (tenant_id, phone) identity rule in migration
  // 0014), so one venue's traffic must not lock them out of another.
  if (!rateLimit(`otp:send:${tenant.id}:${phone}`, 3, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const provider = getOtpProvider()
  // The id is generated here rather than by the database default because the
  // hash is bound to it — see hashOtpCode().
  const challengeId = randomUUID()
  const code = provider.issueCode()
  const codeHash = hashOtpCode({ challengeId, tenantId: tenant.id, phone, code })

  const created = await withPublicTenant(tenant.id, async (tx) => {
    await pruneExpiredChallenges(tx, tenant.id)
    return createChallenge(tx, { id: challengeId, tenantId: tenant.id, phone, codeHash })
  })

  if (!created.ok) {
    return {
      error: `A code was already sent. You can request another in ${created.retryAfterSeconds}s.`,
      retryAfterSeconds: created.retryAfterSeconds,
    }
  }

  try {
    await provider.sendOtp(phone, code)
  } catch (e) {
    await withPublicTenant(tenant.id, (tx) => voidChallenge(tx, challengeId))
    // The gateway error carries a status and a sanitised message and never a
    // credential (see lib/otp/msg91.ts), but it is still gateway-authored, so
    // the customer gets our own sentence and the detail goes to the server log.
    console.error(
      '[customer-otp] delivery failed:',
      e instanceof Error ? e.message : 'unknown error',
    )
    return { error: 'We could not send the code right now. Please try again in a moment.' }
  }

  return { ok: true, expiresInSeconds: OTP_TTL_SECONDS }
}

// ── verify ───────────────────────────────────────────────────────────────────

const verifyInput = z.object({
  phone: z.string().trim().min(6).max(20),
  code: z.string().trim().max(12),
  /** Only used when the customer row is created for the very first time. */
  name: z.string().trim().max(100).optional().or(z.literal('')),
})

export type VerifyOtpResult = { ok?: true; error?: string }

/**
 * Step 2: check the code, then sign the customer in.
 *
 * The attempt is spent, the code compared, and the challenge burned inside ONE
 * transaction. claimAttempt() locks the challenge row for the rest of that
 * transaction, so two requests arriving with the same correct code cannot both
 * be treated as a login: the second blocks, then finds consumed_at already set
 * and is refused.
 */
export async function verifyOtp(raw: z.input<typeof verifyInput>): Promise<VerifyOtpResult> {
  const ip = await callerIp()
  if (!rateLimit(`otp:verify:ip:${ip}`, 30, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const tenant = await resolvePublicTenant()
  if ('error' in tenant) return tenant

  const parsed = verifyInput.safeParse(raw)
  if (!parsed.success) return { error: GENERIC_CODE_ERROR }

  const phone = normalizePhone(parsed.data.phone)
  if (!phone) return { error: GENERIC_CODE_ERROR }

  // A per-challenge attempt cap already exists in the database; this second
  // limit is what stops an attacker cheaply cycling send → guess → send.
  if (!rateLimit(`otp:verify:${tenant.id}:${phone}`, 15, 10 * 60_000).ok) {
    return { error: RATE_LIMIT_MESSAGE }
  }

  const code = parsed.data.code
  if (!isValidOtpCodeFormat(code)) return { error: GENERIC_CODE_ERROR }

  const provider = getOtpProvider()

  const outcome = await withPublicTenant(tenant.id, async (tx) => {
    const challenge = await claimAttempt(tx, tenant.id, phone)
    // Null covers "no challenge", "expired", "already used" and "out of
    // attempts" — all indistinguishable to the caller, by design.
    if (!challenge) return null

    const ok = await provider.verifyOtp(
      { challengeId: challenge.id, tenantId: tenant.id, phone, code },
      challenge.codeHash,
    )
    // The attempt was already counted by claimAttempt(), so a wrong guess costs
    // one regardless of what the caller does next.
    if (!ok) return null

    if (!(await consumeChallenge(tx, challenge.id))) return null

    // Only now does a customer row get touched. Find-or-create runs in the same
    // transaction under the public policies from 0023, and is itself safe
    // against a concurrent first-time login (on conflict do nothing + re-read).
    const customer = await findOrCreateCustomer(tx, tenant.id, {
      phone,
      name: parsed.data.name || undefined,
    })
    return { customerId: customer.id }
  })

  if (!outcome) return { error: GENERIC_CODE_ERROR }

  await createCustomerSession({ tenantId: tenant.id, customerId: outcome.customerId })
  return { ok: true }
}

// ── sign out ─────────────────────────────────────────────────────────────────

/**
 * Sign the customer out and return them to the OTP login.
 *
 * Touches ONLY the customer session: destroyCustomerSession() revokes the
 * customer_sessions row and deletes the `arena_customer_session` cookie. The
 * staff SESSION_COOKIE is never read or cleared here — the two audiences share
 * a hostname, and a customer signing out of the portal on a shared front-desk
 * machine must not sign the receptionist out of the till.
 */
export async function customerSignOut(): Promise<void> {
  await destroyCustomerSession()
  redirect(CUSTOMER_LOGIN_PATH)
}

/**
 * Whether this deployment runs the development bypass, so a login form can say
 * so. Safe to send to the browser: it is false in every production build by
 * construction (lib/otp/config.ts refuses to start otherwise), and when true
 * the code it implies is already in the startup banner and .env.example.
 */
export async function isOtpDevBypassActive(): Promise<boolean> {
  return isOtpBypassActive()
}
