/**
 * The customer-portal session cookie name.
 *
 * Separate file from ./cookie.ts, and dependency-free for the same reason that
 * one is: the edge proxy imports it, so it must not pull in server-only code.
 *
 * A DIFFERENT name from SESSION_COOKIE is the whole security property. Staff
 * and customers share a hostname (both live on {slug}.{rootDomain}), so if the
 * two audiences used one cookie name they would overwrite each other and,
 * worse, a token issued for one audience would be presented to the resolver
 * for the other. With two names each resolver only ever sees its own tokens,
 * and the tokens are looked up in different tables anyway — a customer token
 * is not a row in `sessions`, and a staff token is not a row in
 * `customer_sessions`.
 */
export const CUSTOMER_SESSION_COOKIE = 'arena_customer_session'
