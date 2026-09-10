/**
 * A minimal stand-in for the Next.js REQUEST RUNTIME, for standalone tsx tests.
 *
 * `next/headers` and `next/cache` only work inside a real request: they read
 * Next's async-local storage, and outside it `cookies()` and `revalidatePath()`
 * throw. That would make every server action untestable from a script — and a
 * server action is exactly where this project's authorization guards live, so
 * "untestable" is not acceptable for them.
 *
 * ── WHAT THIS DOES AND DOES NOT WEAKEN ─────────────────────────────────────
 *
 * It supplies a cookie jar and a no-op cache invalidator. It does NOT stub
 * `getCurrentUser()`, `requirePlatformAdmin()`, any RLS policy, any grant, or
 * any business rule. The session token this jar returns is looked up against
 * the REAL `sessions` table by the REAL session code, so a test that "signs in"
 * as a non-admin is genuinely refused by the genuine guard.
 *
 * The one thing lost is cache revalidation, which has no observable behaviour
 * outside a running Next server.
 *
 * Set the active session from a test with:
 *
 *     globalThis.__ARENA_TEST_SESSION = '<session token>'   // or undefined
 */

/** The cookie jar Next would otherwise provide. Backed by a global the test sets. */
function jar() {
  return {
    get(name) {
      const value = globalThis.__ARENA_TEST_SESSION
      return value ? { name, value } : undefined
    },
    getAll() {
      const value = globalThis.__ARENA_TEST_SESSION
      return value ? [{ name: 'session', value }] : []
    },
    has() {
      return Boolean(globalThis.__ARENA_TEST_SESSION)
    },
    // Writes are accepted and dropped: a script has no response to attach a
    // Set-Cookie to, and no test here asserts on one.
    set() {},
    delete() {},
  }
}

/**
 * The request headers Next would otherwise provide.
 *
 * Needed to reach a TENANT-scoped action at all: getActiveContext() resolves
 * which workspace a request belongs to from `x-tenant-slug` (set by proxy.ts
 * from the subdomain), so without one every requireOwner()/requireManager()
 * call refuses for want of a tenant rather than for want of a role — which
 * would make an authorization test pass for entirely the wrong reason.
 *
 * Set from a test with:
 *
 *     globalThis.__ARENA_TEST_HEADERS = { 'x-tenant-slug': 'acme' }
 */
function headerBag() {
  return new Headers(globalThis.__ARENA_TEST_HEADERS ?? {})
}

module.exports = {
  // next/headers
  cookies: async () => jar(),
  headers: async () => headerBag(),
  draftMode: async () => ({ isEnabled: false, enable() {}, disable() {} }),

  // next/cache
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn) => fn,
  unstable_noStore: () => {},
}
