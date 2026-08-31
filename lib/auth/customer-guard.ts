import 'server-only'
import { redirect } from 'next/navigation'
import { getCurrentCustomer, type CurrentCustomer } from './customer-session'

/**
 * Route guards for the customer portal — the customer-side twin of ./guard.ts.
 *
 * Kept in a separate module from the staff guards on purpose. requireContext()
 * and requireManager() resolve a `users` row and a membership ROLE; nothing
 * here has a role at all, and a customer must never be able to satisfy a staff
 * guard or vice versa. Two files with no shared helper means the two ideas
 * cannot be confused at a call site, or accidentally merged by a later
 * refactor.
 */

/** Where an unauthenticated visitor is sent. Public — see proxy.ts. */
export const CUSTOMER_LOGIN_PATH = '/account/login'

/**
 * The signed-in customer, or a redirect to the OTP login.
 *
 * Used by the portal layout, which is what actually protects the route group.
 * proxy.ts also bounces a request with no customer cookie, but that check is
 * deliberately shallow — it never touches the database, exactly like the staff
 * check it sits beside — so a present-but-invalid, expired, revoked or
 * wrong-tenant cookie is caught HERE, on the render path, where the session is
 * really validated.
 *
 * `next` carries the path the visitor was trying to reach so login can return
 * them to it. It is a plain relative path; sanitising it is
 * safeCustomerNext()'s job, at the point it is consumed.
 */
export async function requireCustomer(next?: string): Promise<CurrentCustomer> {
  const customer = await getCurrentCustomer()
  if (!customer) {
    redirect(next ? `${CUSTOMER_LOGIN_PATH}?next=${encodeURIComponent(next)}` : CUSTOMER_LOGIN_PATH)
  }
  return customer
}

/** The portal's home, and the fallback for anything safeCustomerNext() rejects. */
export const CUSTOMER_HOME_PATH = '/account'

/**
 * Sanitise a `?next=` value into a path we are willing to redirect to.
 *
 * Open-redirect protection. An attacker who can choose the post-login
 * destination can send a freshly-authenticated customer to a look-alike site,
 * so anything that is not plainly a path inside this portal is discarded in
 * favour of the portal home:
 *
 *   * must start with a single '/' — rejects 'https://evil.test' and, via the
 *     second character check, protocol-relative '//evil.test' (which a browser
 *     treats as an absolute URL);
 *   * must not contain a backslash — some clients normalise '\' to '/', so
 *     '/\evil.test' can escape the same way;
 *   * must be under /account once RESOLVED, so the value cannot be used to
 *     bounce through an unrelated part of the app.
 *
 * That last word — resolved — is the point of the URL round-trip below. A
 * literal prefix test is not enough: '/account/../../evil' starts with
 * '/account/' and the BROWSER then resolves it to '/evil', straight out of the
 * portal this function exists to confine the value to. Normalising first makes
 * the check answer the question that actually matters, which is where the
 * navigation ends up rather than how it was spelled. The same applies to the
 * percent-encoded spelling '%2e%2e', which the URL parser folds to '..' too.
 *
 * The query string is preserved (the proxy puts the whole destination in
 * `next`, so a deep link keeps its ?tab=…), and it is carried across from the
 * PARSED url, so it cannot smuggle anything past the path checks.
 */

/**
 * Throwaway base for resolving a relative path. Never appears in the return
 * value — only `pathname` and `search` are read back out of the parsed URL —
 * and a value that resolves to any other origin is rejected outright.
 */
const NORMALISE_ORIGIN = 'http://portal.invalid'

export function safeCustomerNext(next: string | null | undefined): string {
  if (!next) return CUSTOMER_HOME_PATH
  if (!next.startsWith('/') || next.startsWith('//')) return CUSTOMER_HOME_PATH
  if (next.includes('\\')) return CUSTOMER_HOME_PATH

  let path: string
  let search: string
  try {
    const resolved = new URL(next, NORMALISE_ORIGIN)
    // Belt and braces: the two checks above already reject everything that
    // could change the origin, so this can only fire if one of them is ever
    // loosened.
    if (resolved.origin !== NORMALISE_ORIGIN) return CUSTOMER_HOME_PATH
    path = resolved.pathname
    search = resolved.search
  } catch {
    return CUSTOMER_HOME_PATH
  }

  if (path !== CUSTOMER_HOME_PATH && !path.startsWith(`${CUSTOMER_HOME_PATH}/`)) {
    return CUSTOMER_HOME_PATH
  }
  // The login page itself is never a destination — it would loop. Tested on the
  // normalised PATH, so neither a trailing slash nor a query string slips past.
  if (path === CUSTOMER_LOGIN_PATH || path === `${CUSTOMER_LOGIN_PATH}/`) {
    return CUSTOMER_HOME_PATH
  }
  return path + search
}
