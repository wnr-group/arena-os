/**
 * The post-login redirect: proxy() → ?next= → safeCustomerNext() (AROS-88).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-customer-redirect.ts
 *
 * Two things had no coverage at all before this file, and both are the kind
 * that fail silently:
 *
 *   * the proxy dropped the QUERY STRING when building `next`, so a deep link
 *     to /account/bookings?tab=past came back from login as the default view;
 *   * safeCustomerNext() tested its "/account only" rule against the raw
 *     string, so '/account/../../evil' passed the prefix check and the browser
 *     then resolved it straight out of the portal.
 *
 * Neither is visible to the type checker and neither breaks a page, so they can
 * only be caught by asserting the WHOLE round trip: what the proxy writes into
 * `next`, and where the login page would then send someone. That is what the
 * roundTrip() helper below does.
 *
 * No database. Both units are pure functions of a request, which is why this
 * suite runs in milliseconds and needs no fixtures.
 */
import { NextRequest } from 'next/server'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

// A tenant subdomain on the dev root domain. tenantSlugFromHost() returns null
// for anything that is not `{slug}.{NEXT_PUBLIC_ROOT_DOMAIN}`, and the customer
// gate only fires when a slug resolved — so the host has to be a real one or
// every assertion below would silently test "no redirect happened".
const ROOT = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000'
const HOST = `demo.${ROOT}`
const ORIGIN = `http://${HOST}`

async function main() {
  const { proxy } = await import('../proxy')
  const { safeCustomerNext, CUSTOMER_HOME_PATH } = await import('../lib/auth/customer-guard')

  /** A signed-out visitor (no cookies of either kind) asking for `path`. */
  const hit = (path: string) =>
    proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { host: HOST } }))

  /** The full round trip: what the proxy writes, and where login would land. */
  const roundTrip = (path: string) => {
    const res = hit(path)
    const location = res.headers.get('location')
    const url = new URL(location ?? '', ORIGIN)
    return {
      redirected: location !== null,
      loginUrl: url.pathname + url.search,
      next: url.searchParams.get('next'),
      landsOn: safeCustomerNext(url.searchParams.get('next')),
    }
  }

  // ══ the gate fires at all ═════════════════════════════════════════════════
  console.log('\n── the customer gate ──')

  const guarded = roundTrip('/account')
  check('a signed-out visitor to /account is redirected', guarded.redirected, guarded)
  check('…to the CUSTOMER login, not the staff one', guarded.loginUrl.startsWith('/account/login'))

  const atLogin = hit('/account/login')
  check('/account/login itself is not redirected (no loop)', atLogin.headers.get('location') === null)

  // ══ the query string survives ═════════════════════════════════════════════
  console.log('\n── the destination survives login ──')

  const deep = roundTrip('/account/bookings?tab=past')
  check('next keeps the query string', deep.next === '/account/bookings?tab=past', deep.next)
  check('…so login lands on ?tab=past', deep.landsOn === '/account/bookings?tab=past', deep.landsOn)
  check('…not the default view', deep.landsOn !== '/account/bookings')
  check(
    'the deep link’s params are not duplicated onto the login URL',
    deep.loginUrl.startsWith('/account/login?next=') && !deep.loginUrl.includes('tab=past&'),
    deep.loginUrl,
  )

  const multi = roundTrip('/account/wallet?tab=loyalty&page=2')
  check('every param survives', multi.landsOn === '/account/wallet?tab=loyalty&page=2', multi.landsOn)

  const encoded = roundTrip('/account/bookings?q=a%20b%26c')
  check('percent-encoding is preserved exactly', encoded.landsOn === '/account/bookings?q=a%20b%26c', encoded.landsOn)

  const plain = roundTrip('/account/bookings')
  check('a path with no query is unchanged', plain.landsOn === '/account/bookings', plain.landsOn)

  // ══ open-redirect protection ══════════════════════════════════════════════
  console.log('\n── safeCustomerNext() rejects what it should ──')

  const rejected: Array<[string, string]> = [
    ['an absolute URL', 'https://evil.test/x'],
    ['a protocol-relative URL', '//evil.test'],
    ['a backslash escape', '/\\evil.test'],
    ['a path outside /account', '/settings/billing'],
    ['the platform admin panel', '/admin'],
    ['the login page (would loop)', '/account/login'],
    ['the login page with a query', '/account/login?next=/account'],
    ['the login page with a trailing slash', '/account/login/'],
    ['nothing at all', ''],
  ]
  for (const [label, value] of rejected) {
    check(`${label} → the portal home`, safeCustomerNext(value) === CUSTOMER_HOME_PATH, safeCustomerNext(value))
  }

  // ══ traversal: the rule is about where you LAND ═══════════════════════════
  // A prefix test on the raw string passes all of these; the browser then
  // resolves them outside /account. They must be judged after normalisation.
  console.log('\n── …including traversal out of /account ──')

  const traversals: Array<[string, string]> = [
    ['plain ..', '/account/../../evil'],
    ['..  to the staff login', '/account/../login'],
    ['single dot segments', '/account/./../admin'],
    ['percent-encoded ..', '/account/%2e%2e/%2e%2e/evil'],
    ['uppercase percent-encoded ..', '/account/%2E%2E/admin'],
    ['traversal carrying a query', '/account/../../evil?x=1'],
  ]
  for (const [label, value] of traversals) {
    const out = safeCustomerNext(value)
    // The property that matters: wherever it points, it is inside the portal.
    const resolved = new URL(out, ORIGIN).pathname
    check(
      `${label} cannot escape the portal`,
      resolved === CUSTOMER_HOME_PATH || resolved.startsWith(`${CUSTOMER_HOME_PATH}/`),
      { input: value, returned: out, resolves: resolved },
    )
  }

  // ══ what must STILL be allowed ════════════════════════════════════════════
  console.log('\n── legitimate destinations still work ──')

  const allowed = [
    '/account',
    '/account/bookings',
    '/account/wallet',
    '/account/profile',
    '/account/bookings/9f1c2f7e-0000-4000-8000-000000000000',
    '/account/bookings?tab=past',
  ]
  for (const value of allowed) {
    check(`${value} is accepted unchanged`, safeCustomerNext(value) === value, safeCustomerNext(value))
  }

  // A traversal that stays inside the portal resolves, rather than being thrown
  // away — normalising must not become a blunt "contains .." rejection.
  check(
    'a traversal that lands back inside /account is normalised, not discarded',
    safeCustomerNext('/account/bookings/../wallet') === '/account/wallet',
    safeCustomerNext('/account/bookings/../wallet'),
  )

  // ══ the staff gate is untouched ═══════════════════════════════════════════
  console.log('\n── the staff gate still behaves ──')

  const staff = hit('/dashboard')
  const staffLocation = staff.headers.get('location')
  check('a signed-out visitor to /dashboard is redirected', staffLocation !== null)
  check(
    '…to the STAFF login, never the customer one',
    staffLocation !== null && new URL(staffLocation, ORIGIN).pathname === '/login',
    staffLocation,
  )

  const publicPage = hit('/book')
  check('the public booking site needs no session', publicPage.headers.get('location') === null)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
