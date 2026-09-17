/**
 * The sign-in page turns away someone already signed in.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * Pressing Back from the dashboard landed on /login, showed the sign-in form,
 * and Back again returned to the dashboard. That reads like the session is
 * being bypassed. It never was — the session stayed valid throughout, so
 * returning to the dashboard was correct. What was wrong is that /login
 * rendered at all for someone holding a live session.
 *
 * Two halves, both covered here:
 *
 *   1. login() REPLACES its redirect instead of pushing, so /login does not
 *      stay in the history stack behind the dashboard.
 *   2. app/login/page.tsx asks getCurrentUser() and redirects away when there
 *      IS one — the durable half, since it holds however the page is reached:
 *      Back, a bookmark, a typed URL, a restored tab.
 *
 * The page's own guard is the predicate below; what this drives is the real
 * session lookup it depends on, against real rows, because the value of the
 * guard is entirely in that lookup being right. A REVOKED or EXPIRED session
 * must still get the form — bouncing it to a dashboard that would only send it
 * back here is the loop this has to avoid.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-login-redirect.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { getCurrentUser } = await import('../lib/auth/session')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testloginredirect'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  await owner.query(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do nothing`, [tenantId])
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
  const userId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active'`, [tenantId, userId])

  await owner.query('delete from sessions where user_id=$1', [userId])

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  /** Mint a real session row and return its cookie token. */
  async function signIn(expiresIn = "interval '1 day'") {
    const token = randomBytes(32).toString('hex')
    await owner.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + ${expiresIn})`,
      [createHash('sha256').update(token).digest('hex'), userId])
    return token
  }

  /** Exactly what app/login/page.tsx decides. */
  const wouldRedirect = async () => (await getCurrentUser()) !== null

  // ══ 1. signed in → turned away ═══════════════════════════════════════════
  console.log('\n── holding a live session ──')
  {
    g.__ARENA_TEST_SESSION = await signIn()
    const user = await getCurrentUser()
    check('the session resolves to a user', user?.id === userId)
    check('…so /login redirects instead of rendering the form', await wouldRedirect())
  }

  // ══ 2. no session at all → the form ══════════════════════════════════════
  console.log('\n── no session ──')
  {
    g.__ARENA_TEST_SESSION = undefined
    check('no cookie means no user', (await getCurrentUser()) === null)
    check('…so the form renders, as it must', !(await wouldRedirect()))
  }

  // ══ 3. a stale cookie → the form, NOT a redirect loop ════════════════════
  // proxy.ts routes on cookie PRESENCE; this guard asks whether the session is
  // real. If it used presence too, a revoked cookie would bounce to /dashboard,
  // which would bounce straight back here, for ever.
  console.log('\n── a cookie whose session is gone ──')
  {
    const token = await signIn()
    g.__ARENA_TEST_SESSION = token
    check('valid to begin with', (await getCurrentUser()) !== null)

    await owner.query('delete from sessions where user_id=$1', [userId])
    check('after the session row is revoked, no user resolves',
      (await getCurrentUser()) === null)
    check('…so the form renders — no bounce, no loop', !(await wouldRedirect()))
  }

  // ══ 4. an EXPIRED session → the form ═════════════════════════════════════
  console.log('\n── an expired session ──')
  {
    g.__ARENA_TEST_SESSION = await signIn("interval '-1 hour'")
    check('an expired session resolves to no user', (await getCurrentUser()) === null)
    check('…so the form renders', !(await wouldRedirect()))
  }

  // ══ 5. a junk cookie → the form ══════════════════════════════════════════
  console.log('\n── a forged cookie ──')
  {
    g.__ARENA_TEST_SESSION = randomBytes(32).toString('hex')
    check('a token with no matching row resolves to no user',
      (await getCurrentUser()) === null)
    check('…so the form renders', !(await wouldRedirect()))
  }

  // ══ 6. signing out then returning ════════════════════════════════════════
  // The mirror image: after signOut() destroys the session, /login must render
  // rather than bounce the visitor back into the app they just left.
  console.log('\n── after signing out ──')
  {
    g.__ARENA_TEST_SESSION = await signIn()
    check('signed in', await wouldRedirect())
    await owner.query('delete from sessions where user_id=$1', [userId])
    g.__ARENA_TEST_SESSION = undefined
    check('signed out — the form renders again', !(await wouldRedirect()))
  }

  await owner.query('delete from sessions where user_id=$1', [userId])
  g.__ARENA_TEST_SESSION = undefined
  g.__ARENA_TEST_HEADERS = undefined
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
