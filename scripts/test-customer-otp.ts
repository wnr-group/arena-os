/**
 * Customer OTP login (AROS-87) — behaviour and security.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-customer-otp.ts
 *
 * Covers the whole login path below the server actions: provider selection and
 * the production refusal, code hashing, the challenge lifecycle (expiry,
 * attempts, single use, concurrency), find-or-create, and the customer session.
 * The server actions themselves need a request context (`cookies()`,
 * `headers()`), so this drives the modules they compose rather than the actions
 * — the same approach scripts/test-customers.ts takes with withUser().
 *
 * No test reaches the network: the MSG91 provider is constructed with a fake
 * SendSmsOtpFn, which is the seam lib/otp/provider.ts exists to provide.
 */
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'
import type { SendSmsOtpFn } from '../lib/otp/msg91'

loadEnv()
// Force the bypass off for this process BEFORE lib/otp/config.ts is imported:
// mode is resolved once at module load, and most of what is asserted below is
// about the real provider. The bypass is exercised through an explicitly
// constructed BypassProvider instead, plus resolveOtpMode() for its guards.
process.env.OTP_DEV_BYPASS = 'false'

type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { resolveOtpMode, OtpConfigError, BYPASS_OTP_CODE } = await import('../lib/otp/config')
  const { Msg91Provider, BypassProvider, getOtpProvider } = await import('../lib/otp/provider')
  const { msg91Mobile, Msg91ApiError } = await import('../lib/otp/msg91')
  const { generateOtpCode, hashOtpCode, otpCodeMatches, isValidOtpCodeFormat, resolveOtpSecret } =
    await import('../lib/otp/code')
  const {
    createChallenge,
    claimAttempt,
    consumeChallenge,
    voidChallenge,
    OTP_MAX_ATTEMPTS,
    OTP_TTL_SECONDS,
    OTP_RESEND_COOLDOWN_SECONDS,
  } = await import('../lib/otp/challenge')
  const { findOrCreateCustomer } = await import('../lib/customers/service')
  const { normalizePhone } = await import('../lib/customers/phone')
  const { SESSION_COOKIE } = await import('../lib/auth/cookie')
  const { CUSTOMER_SESSION_COOKIE } = await import('../lib/auth/customer-cookie')
  const {
    issueCustomerSession,
    lookupCustomerSession,
    revokeCustomerSessionToken,
    revokeAllCustomerSessions,
    customerSessionTokenId,
  } = await import('../lib/auth/customer-session')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withPublicTenant — the public RLS context. */
  async function withPublicTenant<T>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set name = excluded.name, status = 'active' returning id`,
      [slug, `${slug} co`],
    )
    return t.rows[0].id
  }

  const tenantA = await makeTenant('testotpa')
  const tenantB = await makeTenant('testotpb')

  const PHONE = '+919876500001'
  const PHONE_B = '+919876500002'

  async function reset() {
    await ownerPool.query('delete from customer_sessions where tenant_id = any($1)', [
      [tenantA, tenantB],
    ])
    await ownerPool.query('delete from customer_otp_challenges where tenant_id = any($1)', [
      [tenantA, tenantB],
    ])
    await ownerPool.query('delete from customers where tenant_id = any($1)', [[tenantA, tenantB]])
  }
  await reset()

  /** Mint a challenge directly, bypassing the resend cooldown, for setup. */
  async function seedChallenge(
    tenantId: string,
    phone: string,
    code: string,
    opts: { expiresInSeconds?: number; attempts?: number; consumed?: boolean } = {},
  ) {
    const id = crypto.randomUUID()
    const codeHash = hashOtpCode({ challengeId: id, tenantId, phone, code })
    await ownerPool.query(
      `insert into customer_otp_challenges
         (id, tenant_id, phone, code_hash, expires_at, attempts, consumed_at)
       values ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7)`,
      [
        id,
        tenantId,
        phone,
        codeHash,
        opts.expiresInSeconds ?? OTP_TTL_SECONDS,
        opts.attempts ?? 0,
        opts.consumed ? new Date() : null,
      ],
    )
    return { id, codeHash }
  }

  // ══ 1. configuration: the production refusal ═══════════════════════════════
  console.log('\n── configuration ──')

  check(
    'bypass off by default (unset OTP_DEV_BYPASS → msg91)',
    resolveOtpMode({ NODE_ENV: 'development' } as NodeJS.ProcessEnv) === 'msg91',
  )
  check(
    "OTP_DEV_BYPASS=true in development → 'bypass'",
    resolveOtpMode({ NODE_ENV: 'development', OTP_DEV_BYPASS: 'true' } as NodeJS.ProcessEnv) ===
      'bypass',
  )
  for (const truthy of ['1', 'yes', 'on', 'TRUE']) {
    check(
      `OTP_DEV_BYPASS=${truthy} is recognised as enabled`,
      resolveOtpMode({ NODE_ENV: 'development', OTP_DEV_BYPASS: truthy } as NodeJS.ProcessEnv) ===
        'bypass',
    )
  }
  for (const falsy of ['false', '0', 'off', '', 'ture']) {
    check(
      `OTP_DEV_BYPASS=${JSON.stringify(falsy)} is NOT enabled`,
      resolveOtpMode({ NODE_ENV: 'development', OTP_DEV_BYPASS: falsy } as NodeJS.ProcessEnv) ===
        'msg91',
    )
  }

  let refused = false
  try {
    resolveOtpMode({ NODE_ENV: 'production', OTP_DEV_BYPASS: 'true' } as NodeJS.ProcessEnv)
  } catch (e) {
    refused = e instanceof OtpConfigError
  }
  check('BYPASS + NODE_ENV=production is REFUSED (throws, not warns)', refused)

  // The one production context that does not throw: `next build`, which runs
  // with NODE_ENV=production. It must force the REAL provider rather than
  // honour the flag, so nothing bypassy can be prerendered into a bundle.
  check(
    'BYPASS during `next build` forces the real provider instead of throwing',
    resolveOtpMode({
      NODE_ENV: 'production',
      OTP_DEV_BYPASS: 'true',
      NEXT_PHASE: 'phase-production-build',
    } as NodeJS.ProcessEnv) === 'msg91',
  )
  // …and that carve-out must not leak into a running production server.
  let refusedAtRuntime = false
  try {
    resolveOtpMode({
      NODE_ENV: 'production',
      OTP_DEV_BYPASS: 'true',
      NEXT_PHASE: 'phase-production-server',
    } as NodeJS.ProcessEnv)
  } catch (e) {
    refusedAtRuntime = e instanceof OtpConfigError
  }
  check('a production SERVER with the flag is still refused', refusedAtRuntime)

  check(
    'production without the flag resolves to the real provider',
    resolveOtpMode({ NODE_ENV: 'production' } as NodeJS.ProcessEnv) === 'msg91',
  )
  check('this process selected the real provider', getOtpProvider().name === 'msg91')

  // ══ 2. code generation + hashing ═══════════════════════════════════════════
  console.log('\n── code + hashing ──')

  const codes = new Set<string>()
  for (let i = 0; i < 500; i++) codes.add(generateOtpCode())
  check('generated codes are all 6 digits', [...codes].every((c) => /^[0-9]{6}$/.test(c)))
  check('generated codes are not constant (500 draws → many distinct)', codes.size > 400)
  check('format validator rejects 5 digits', !isValidOtpCodeFormat('12345'))
  check('format validator rejects letters', !isValidOtpCodeFormat('12a456'))
  check('format validator accepts a leading-zero code', isValidOtpCodeFormat('012345'))

  const hashInput = { challengeId: crypto.randomUUID(), tenantId: tenantA, phone: PHONE, code: '424242' }
  const h = hashOtpCode(hashInput)
  check('hash is hex sha256 (64 chars)', /^[0-9a-f]{64}$/.test(h))
  check('hash matches the same code', otpCodeMatches(hashInput, h))
  check('hash rejects a different code', !otpCodeMatches({ ...hashInput, code: '424243' }, h))
  check(
    'hash is bound to the challenge id (a hash lifted onto another row fails)',
    !otpCodeMatches({ ...hashInput, challengeId: crypto.randomUUID() }, h),
  )
  check(
    'hash is bound to the tenant (same code, other tenant, fails)',
    !otpCodeMatches({ ...hashInput, tenantId: tenantB }, h),
  )
  check(
    'hash is bound to the phone (same code, other number, fails)',
    !otpCodeMatches({ ...hashInput, phone: PHONE_B }, h),
  )
  check('hashing is deterministic for the same input', hashOtpCode(hashInput) === h)
  // The property that matters: the stored digest is NOT something an attacker
  // can reproduce from the code alone. If this ever equalled the plain digest,
  // reading the table would hand over every live OTP.
  const unkeyed = createHash('sha256').update(hashInput.code).digest('hex')
  const unkeyedBound = createHash('sha256')
    .update(`${hashInput.challengeId}|${hashInput.tenantId}|${hashInput.phone}|${hashInput.code}`)
    .digest('hex')
  check('the stored hash is keyed, not a plain sha256 of the code', h !== unkeyed)
  check('…nor a plain sha256 of the bound tuple', h !== unkeyedBound)

  let placeholderRejected = false
  try {
    resolveOtpSecret('change-me-to-a-long-random-string')
  } catch {
    placeholderRejected = true
  }
  check('the .env.example placeholder secret is refused', placeholderRejected)

  let shortRejected = false
  try {
    resolveOtpSecret('tooshort')
  } catch {
    shortRejected = true
  }
  check('a too-short secret is refused', shortRejected)

  // ══ 3. the challenge lifecycle ═════════════════════════════════════════════
  console.log('\n── challenge lifecycle ──')

  await reset()
  const goodCode = '135790'
  const created = await withPublicTenant(tenantA, (tx) =>
    createChallenge(tx, {
      id: crypto.randomUUID(),
      tenantId: tenantA,
      phone: PHONE,
      codeHash: 'f'.repeat(64),
    }),
  )
  check('a first challenge is accepted', created.ok === true)

  const second = await withPublicTenant(tenantA, (tx) =>
    createChallenge(tx, {
      id: crypto.randomUUID(),
      tenantId: tenantA,
      phone: PHONE,
      codeHash: 'e'.repeat(64),
    }),
  )
  check('an immediate resend is refused (cooldown)', second.ok === false)
  check(
    'the refusal reports a retry-after inside the cooldown window',
    second.ok === false &&
      second.retryAfterSeconds > 0 &&
      second.retryAfterSeconds <= OTP_RESEND_COOLDOWN_SECONDS,
  )

  const rowsAfterResend = await ownerPool.query(
    'select count(*) n from customer_otp_challenges where tenant_id = $1 and phone = $2',
    [tenantA, PHONE],
  )
  check('the refused resend wrote no second row', Number(rowsAfterResend.rows[0].n) === 1)

  const otherPhone = await withPublicTenant(tenantA, (tx) =>
    createChallenge(tx, {
      id: crypto.randomUUID(),
      tenantId: tenantA,
      phone: PHONE_B,
      codeHash: 'd'.repeat(64),
    }),
  )
  check('the cooldown is per phone, not per tenant', otherPhone.ok === true)

  const sameCustomerOtherTenant = await withPublicTenant(tenantB, (tx) =>
    createChallenge(tx, {
      id: crypto.randomUUID(),
      tenantId: tenantB,
      phone: PHONE,
      codeHash: 'c'.repeat(64),
    }),
  )
  check(
    'the cooldown is per tenant — the same number can log in at another venue',
    sameCustomerOtherTenant.ok === true,
  )

  // never stored in the clear
  const stored = await ownerPool.query<{ code_hash: string }>(
    'select code_hash from customer_otp_challenges where tenant_id = $1',
    [tenantA],
  )
  check(
    'no stored row holds anything that looks like a plaintext code',
    stored.rows.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)),
  )

  let plaintextRejected = false
  try {
    await ownerPool.query(
      `insert into customer_otp_challenges (tenant_id, phone, code_hash, expires_at)
       values ($1,$2,'123456', now() + interval '5 minutes')`,
      [tenantA, PHONE],
    )
  } catch {
    plaintextRejected = true
  }
  check('the database CHECK refuses a plaintext code in code_hash', plaintextRejected)

  let badPhoneRejected = false
  try {
    await ownerPool.query(
      `insert into customer_otp_challenges (tenant_id, phone, code_hash, expires_at)
       values ($1,'9876543210',$2, now() + interval '5 minutes')`,
      [tenantA, 'a'.repeat(64)],
    )
  } catch {
    badPhoneRejected = true
  }
  check('the database CHECK refuses a non-E.164 phone', badPhoneRejected)

  // ── verify: correct code ──
  await reset()
  const provider = new Msg91Provider(async () => {})
  await seedChallenge(tenantA, PHONE, goodCode)

  const verified = await withPublicTenant(tenantA, async (tx) => {
    const claimed = await claimAttempt(tx, tenantA, PHONE)
    if (!claimed) return false
    const ok = await provider.verifyOtp(
      { challengeId: claimed.id, tenantId: tenantA, phone: PHONE, code: goodCode },
      claimed.codeHash,
    )
    if (!ok) return false
    return consumeChallenge(tx, claimed.id)
  })
  check('a correct code verifies and consumes the challenge', verified === true)

  const reuse = await withPublicTenant(tenantA, (tx) => claimAttempt(tx, tenantA, PHONE))
  check('the consumed challenge cannot be claimed again (replay blocked)', reuse === null)

  // ── verify: wrong code costs an attempt ──
  await reset()
  await seedChallenge(tenantA, PHONE, goodCode)
  const wrong = await withPublicTenant(tenantA, async (tx) => {
    const claimed = await claimAttempt(tx, tenantA, PHONE)
    if (!claimed) return null
    return provider.verifyOtp(
      { challengeId: claimed.id, tenantId: tenantA, phone: PHONE, code: '000000' },
      claimed.codeHash,
    )
  })
  check('a wrong code is rejected', wrong === false)
  const attemptRow = await ownerPool.query<{ attempts: number }>(
    'select attempts from customer_otp_challenges where tenant_id = $1 and phone = $2',
    [tenantA, PHONE],
  )
  check('a wrong code costs one attempt', Number(attemptRow.rows[0].attempts) === 1)

  // ── expiry ──
  await reset()
  await seedChallenge(tenantA, PHONE, goodCode, { expiresInSeconds: -1 })
  const expired = await withPublicTenant(tenantA, (tx) => claimAttempt(tx, tenantA, PHONE))
  check('an expired challenge cannot be claimed', expired === null)

  // ── attempt limit ──
  await reset()
  await seedChallenge(tenantA, PHONE, goodCode)
  let claimedCount = 0
  for (let i = 0; i < OTP_MAX_ATTEMPTS + 3; i++) {
    const claimed = await withPublicTenant(tenantA, (tx) => claimAttempt(tx, tenantA, PHONE))
    if (claimed) claimedCount++
  }
  check(
    `exactly ${OTP_MAX_ATTEMPTS} attempts are allowed, then the challenge is dead`,
    claimedCount === OTP_MAX_ATTEMPTS,
  )
  const burned = await withPublicTenant(tenantA, async (tx) => {
    const claimed = await claimAttempt(tx, tenantA, PHONE)
    return claimed === null
  })
  check('the CORRECT code no longer works once attempts are exhausted', burned)

  // ── voided challenge (failed SMS delivery) ──
  await reset()
  const voided = await seedChallenge(tenantA, PHONE, goodCode)
  await withPublicTenant(tenantA, (tx) => voidChallenge(tx, voided.id))
  const afterVoid = await withPublicTenant(tenantA, (tx) => claimAttempt(tx, tenantA, PHONE))
  check('a challenge voided after a delivery failure cannot be used', afterVoid === null)
  const voidedRow = await ownerPool.query(
    'select consumed_at from customer_otp_challenges where id = $1',
    [voided.id],
  )
  check('…and it stays on file, so it still occupies the resend cooldown', voidedRow.rowCount === 1)

  // ── concurrency: two correct codes at once ──
  await reset()
  await seedChallenge(tenantA, PHONE, goodCode)
  const attemptLogin = async () =>
    withPublicTenant(tenantA, async (tx) => {
      const claimed = await claimAttempt(tx, tenantA, PHONE)
      if (!claimed) return false
      const ok = await provider.verifyOtp(
        { challengeId: claimed.id, tenantId: tenantA, phone: PHONE, code: goodCode },
        claimed.codeHash,
      )
      if (!ok) return false
      return consumeChallenge(tx, claimed.id)
    })
  const both = await Promise.all([attemptLogin(), attemptLogin()])
  check(
    'two concurrent verifications of the SAME code produce exactly one login',
    both.filter(Boolean).length === 1,
  )

  // ── cross-tenant ──
  await reset()
  await seedChallenge(tenantA, PHONE, goodCode)
  const crossRead = await withPublicTenant(tenantB, (tx) => claimAttempt(tx, tenantB, PHONE))
  check("tenant B cannot claim tenant A's challenge", crossRead === null)

  const crossVisible = await withPublicTenant(tenantB, (tx) =>
    tx.execute<{ n: string }>(sql`select count(*)::text n from public.customer_otp_challenges`),
  )
  check(
    "tenant B's context sees zero of tenant A's challenge rows (RLS)",
    Number(crossVisible.rows[0].n) === 0,
  )

  // A code minted for tenant A, replayed against tenant B's own challenge.
  await seedChallenge(tenantB, PHONE, '999999')
  const crossCode = await withPublicTenant(tenantB, async (tx) => {
    const claimed = await claimAttempt(tx, tenantB, PHONE)
    if (!claimed) return null
    return provider.verifyOtp(
      { challengeId: claimed.id, tenantId: tenantB, phone: PHONE, code: goodCode },
      claimed.codeHash,
    )
  })
  check("tenant A's code does not verify against tenant B's challenge", crossCode === false)

  // ══ 4. the development bypass ══════════════════════════════════════════════
  console.log('\n── development bypass ──')

  const bypass = new BypassProvider()
  check('bypass issues the documented fixed code', bypass.issueCode() === BYPASS_OTP_CODE)
  check('the documented fixed code is 123456', BYPASS_OTP_CODE === '123456')

  await reset()
  const bypassChallenge = await seedChallenge(tenantA, PHONE, bypass.issueCode())
  const bypassOk = await bypass.verifyOtp(
    { challengeId: bypassChallenge.id, tenantId: tenantA, phone: PHONE, code: '123456' },
    bypassChallenge.codeHash,
  )
  check('bypass accepts 123456 for a valid phone', bypassOk === true)

  const bypassWrong = await bypass.verifyOtp(
    { challengeId: bypassChallenge.id, tenantId: tenantA, phone: PHONE, code: '654321' },
    bypassChallenge.codeHash,
  )
  check('bypass rejects every other code', bypassWrong === false)

  // Even if the stored hash were forged for another code, the literal check holds.
  const forged = hashOtpCode({
    challengeId: bypassChallenge.id,
    tenantId: tenantA,
    phone: PHONE,
    code: '777777',
  })
  const bypassForged = await bypass.verifyOtp(
    { challengeId: bypassChallenge.id, tenantId: tenantA, phone: PHONE, code: '777777' },
    forged,
  )
  check('bypass refuses a non-123456 code even when its hash matches', bypassForged === false)

  // Prove it by making any outbound HTTP call fail loudly for the duration.
  const realFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('the bypass provider must never make a network call')
  }) as typeof fetch
  let bypassSendThrew = false
  try {
    await bypass.sendOtp()
  } catch {
    bypassSendThrew = true
  }
  globalThis.fetch = realFetch
  check('bypass sends without error', !bypassSendThrew)
  check('bypass makes NO network call (MSG91 is never reached)', fetchCalls === 0)

  // The bypass still writes a real challenge that expires and counts attempts —
  // proven by reusing the same lifecycle assertions above through its code.
  await reset()
  await seedChallenge(tenantA, PHONE, BYPASS_OTP_CODE, { expiresInSeconds: -1 })
  const bypassExpired = await withPublicTenant(tenantA, (tx) => claimAttempt(tx, tenantA, PHONE))
  check('a bypass challenge still expires', bypassExpired === null)

  // ══ 5. the MSG91 provider ══════════════════════════════════════════════════
  console.log('\n── MSG91 provider ──')

  process.env.MSG91_AUTH_KEY = 'test-auth-key-not-a-real-secret'
  process.env.MSG91_TEMPLATE_ID = 'test-template-id'

  const calls: Array<{ authKey: string; phone: string; code: string; templateId: string }> = []
  const fakeSend: SendSmsOtpFn = async (config, params) => {
    calls.push({
      authKey: config.authKey,
      templateId: config.templateId,
      phone: params.phone,
      code: params.code,
    })
  }
  const msg91 = new Msg91Provider(fakeSend)
  calls.length = 0

  const issued = msg91.issueCode()
  await msg91.sendOtp(PHONE, issued)
  check('msg91 provider delivers exactly one message', calls.length === 1)
  check('…to the number it was given', calls[0].phone === PHONE)
  check('…carrying the code we issued (gateway is delivery-only)', calls[0].code === issued)
  check('…using the configured template', calls[0].templateId === 'test-template-id')

  const issuedChallenge = await seedChallenge(tenantA, PHONE_B, issued)
  check(
    'the real issued code verifies',
    (await msg91.verifyOtp(
      { challengeId: issuedChallenge.id, tenantId: tenantA, phone: PHONE_B, code: issued },
      issuedChallenge.codeHash,
    )) === true,
  )
  const otherCode = issued === '000000' ? '111111' : '000000'
  check(
    'a wrong code is rejected by the real provider',
    (await msg91.verifyOtp(
      { challengeId: issuedChallenge.id, tenantId: tenantA, phone: PHONE_B, code: otherCode },
      issuedChallenge.codeHash,
    )) === false,
  )
  check(
    'the bypass code is NOT accepted by the real provider',
    (await msg91.verifyOtp(
      { challengeId: issuedChallenge.id, tenantId: tenantA, phone: PHONE_B, code: BYPASS_OTP_CODE },
      issuedChallenge.codeHash,
    )) === false,
  )

  // failure handling
  const failing = new Msg91Provider(async () => {
    throw new Msg91ApiError('The SMS gateway rejected the request.', 400, false)
  })
  let sendError: unknown = null
  try {
    await failing.sendOtp(PHONE, '123123')
  } catch (e) {
    sendError = e
  }
  check('a gateway failure surfaces as Msg91ApiError', sendError instanceof Msg91ApiError)
  check(
    'the gateway error carries no credential material',
    sendError instanceof Error &&
      !sendError.message.includes('test-auth-key-not-a-real-secret') &&
      !sendError.message.includes('123123'),
  )

  check('E.164 is stripped to the digits MSG91 wants', msg91Mobile('+919876543210') === '919876543210')
  let mobileRejected = false
  try {
    msg91Mobile('9876543210')
  } catch {
    mobileRejected = true
  }
  check('a non-E.164 number is refused before it reaches the gateway', mobileRejected)

  // missing credentials
  const savedKey = process.env.MSG91_AUTH_KEY
  delete process.env.MSG91_AUTH_KEY
  let configError = false
  try {
    await new Msg91Provider(fakeSend).sendOtp(PHONE, '123123')
  } catch (e) {
    configError = e instanceof OtpConfigError
  }
  check('a missing MSG91_AUTH_KEY is a clear configuration error', configError)
  process.env.MSG91_AUTH_KEY = savedKey

  // ══ 6. find-or-create customer ═════════════════════════════════════════════
  console.log('\n── customer find-or-create ──')

  await reset()
  check(
    'the OTP path normalises to the same E.164 the customers CHECK expects',
    normalizePhone('98765 00001') === PHONE,
  )

  const c1 = await withPublicTenant(tenantA, (tx) =>
    findOrCreateCustomer(tx, tenantA, { phone: PHONE, name: 'Asha' }),
  )
  check('a first-time login creates the customer', c1.phone === PHONE)

  const c2 = await withPublicTenant(tenantA, (tx) =>
    findOrCreateCustomer(tx, tenantA, { phone: '9876500001' }),
  )
  check('a second login finds the same customer (no duplicate)', c2.id === c1.id)
  check('…and does not blank the name already on file', c2.name === 'Asha')

  const concurrent = await Promise.all([
    withPublicTenant(tenantB, (tx) => findOrCreateCustomer(tx, tenantB, { phone: PHONE })),
    withPublicTenant(tenantB, (tx) => findOrCreateCustomer(tx, tenantB, { phone: PHONE })),
  ])
  check(
    'two concurrent first-time logins create ONE customer',
    concurrent[0].id === concurrent[1].id,
  )
  const countB = await ownerPool.query<{ n: string }>(
    'select count(*) n from customers where tenant_id = $1 and phone = $2',
    [tenantB, PHONE],
  )
  check('…confirmed by the row count', Number(countB.rows[0].n) === 1)
  check('the same phone at another tenant is a DIFFERENT customer', concurrent[0].id !== c1.id)

  // ══ 7. customer session ════════════════════════════════════════════════════
  console.log('\n── customer session ──')

  // Widened to string on purpose: with the literal types tsc proves this can
  // never be equal, which is the guarantee we want — but it also refuses to
  // compile the comparison. Keeping it as a runtime check means the day
  // somebody "tidies up" by pointing both constants at one value, a test fails
  // rather than the two audiences silently sharing a cookie.
  const staffCookieName: string = SESSION_COOKIE
  const customerCookieName: string = CUSTOMER_SESSION_COOKIE
  check(
    'the customer cookie name differs from the staff cookie name',
    customerCookieName !== staffCookieName,
  )
  check('staff cookie is unchanged', SESSION_COOKIE === 'arena_session')
  check('customer cookie is namespaced', CUSTOMER_SESSION_COOKIE === 'arena_customer_session')

  const { token } = await issueCustomerSession({ tenantId: tenantA, customerId: c1.id })
  const resolved = await lookupCustomerSession(token, tenantA)
  check('a session token resolves to its customer', resolved?.id === c1.id)

  const storedSession = await ownerPool.query<{ id: string }>(
    'select id from customer_sessions where tenant_id = $1',
    [tenantA],
  )
  check(
    'the raw token is NOT stored — only its sha256',
    storedSession.rows.every((r) => r.id !== token && r.id === customerSessionTokenId(token)),
  )

  check(
    "the token does not resolve against another tenant",
    (await lookupCustomerSession(token, tenantB)) === null,
  )

  const staffSession = await ownerPool.query<{ id: string }>(
    `insert into users (email, password_hash) values ($1,'x')
     on conflict (email) do update set email = excluded.email returning id`,
    ['otp-staff@testotpa.test'],
  )
  const staffToken = 'a'.repeat(64)
  await ownerPool.query(
    `insert into sessions (id, user_id, expires_at)
     values ($1, $2, now() + interval '1 day') on conflict (id) do nothing`,
    [customerSessionTokenId(staffToken), staffSession.rows[0].id],
  )
  check(
    'a STAFF session token does not authenticate a customer',
    (await lookupCustomerSession(staffToken, tenantA)) === null,
  )
  const customerRowInStaffTable = await ownerPool.query(
    'select 1 from sessions where id = $1',
    [customerSessionTokenId(token)],
  )
  check(
    'a CUSTOMER session token is not a row in the staff sessions table',
    customerRowInStaffTable.rowCount === 0,
  )

  await revokeCustomerSessionToken(token)
  check(
    'a revoked session stops resolving',
    (await lookupCustomerSession(token, tenantA)) === null,
  )

  const { token: t2 } = await issueCustomerSession({ tenantId: tenantA, customerId: c1.id })
  const { token: t3 } = await issueCustomerSession({
    tenantId: tenantA,
    customerId: c1.id,
    previousToken: t2,
  })
  check('rotation revokes the previous token', (await lookupCustomerSession(t2, tenantA)) === null)
  check('…and the new one works', (await lookupCustomerSession(t3, tenantA))?.id === c1.id)

  await ownerPool.query(
    "update customer_sessions set expires_at = now() - interval '1 minute' where id = $1",
    [customerSessionTokenId(t3)],
  )
  check('an expired session stops resolving', (await lookupCustomerSession(t3, tenantA)) === null)

  const { token: t4 } = await issueCustomerSession({ tenantId: tenantA, customerId: c1.id })
  await revokeAllCustomerSessions({ tenantId: tenantA, customerId: c1.id })
  check('revoke-all kills live sessions', (await lookupCustomerSession(t4, tenantA)) === null)

  // A session row pointing at another tenant's customer must be impossible.
  let crossSessionBlocked = false
  try {
    await ownerPool.query(
      `insert into customer_sessions (id, tenant_id, customer_id, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      ['x'.repeat(64), tenantB, c1.id],
    )
  } catch {
    crossSessionBlocked = true
  }
  check(
    "a session for tenant B pointing at tenant A's customer cannot be written (composite FK)",
    crossSessionBlocked,
  )

  // The app role must not be able to touch the session table at all.
  let appBlocked = false
  try {
    await app.execute(sql`select count(*) from public.customer_sessions`)
  } catch {
    appBlocked = true
  }
  check('the app role cannot read customer_sessions (not granted)', appBlocked)

  await reset()
  await ownerPool.query('delete from sessions where user_id = $1', [staffSession.rows[0].id])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
