import 'server-only'
import { cache } from 'react'
import { randomBytes, createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { customerSessions, customers } from '@/db/schema'
import { CUSTOMER_SESSION_COOKIE as COOKIE } from './customer-cookie'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'

/**
 * Customer-portal sessions — the customer-side twin of ./session.ts.
 *
 * Structurally identical to the staff implementation (opaque random token in
 * the cookie, only its SHA-256 in the database, rotate on login, resolver
 * wrapped in React `cache()`), and deliberately SEPARATE from it at every
 * layer: different table, different cookie, different resolver, different
 * identity type. Nothing here can authenticate a `users` row and nothing in
 * ./session.ts can authenticate a `customers` row.
 *
 * Like `sessions`, `customer_sessions` is not granted to the app role, so this
 * module uses the owner connection: session tokens are identity infrastructure
 * that no tenant-scoped query should ever be able to enumerate.
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

export type CurrentCustomer = {
  id: string
  tenantId: string
  phone: string
  name: string | null
  email: string | null
}

/**
 * The cookie carries the token; the DB stores only its SHA-256.
 *
 * Exported so a test can assert the separation property directly — that a
 * staff token is not a customer session id and vice versa — without having to
 * reimplement the derivation and accidentally test its own copy.
 */
export function customerSessionTokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const tokenId = customerSessionTokenId

/**
 * Mint a session row and return the raw token.
 *
 * Split from the cookie write below so the durable half — insert, rotation,
 * expiry — is reachable from a plain Node script; `cookies()` only exists
 * inside a request. Callers in the app should use createCustomerSession().
 */
export async function issueCustomerSession(input: {
  tenantId: string
  customerId: string
  /** Revoked before the new one is issued, if given. */
  previousToken?: string | null
}): Promise<{ token: string; expiresAt: Date }> {
  if (input.previousToken) {
    await revokeCustomerSessionToken(input.previousToken)
  }

  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await ownerDb.insert(customerSessions).values({
    id: tokenId(token),
    tenantId: input.tenantId,
    customerId: input.customerId,
    expiresAt,
  })

  return { token, expiresAt }
}

/**
 * The session read, with no cookie involved: resolve a raw token to a customer,
 * scoped to one tenant.
 *
 * The tenant predicate is not decoration. A customer of one venue must never
 * resolve as a customer of another, so the lookup requires the session row's
 * tenant to equal the tenant being asked about; a token from another venue
 * matches zero rows rather than being trusted. The composite FK in migration
 * 0044 backs this up by making a session row that points at another tenant's
 * customer impossible to write in the first place.
 */
export async function lookupCustomerSession(
  token: string,
  tenantId: string,
): Promise<CurrentCustomer | null> {
  const rows = await ownerDb
    .select({
      id: customers.id,
      tenantId: customers.tenantId,
      phone: customers.phone,
      name: customers.name,
      email: customers.email,
    })
    .from(customerSessions)
    .innerJoin(
      customers,
      and(
        eq(customers.id, customerSessions.customerId),
        eq(customers.tenantId, customerSessions.tenantId),
      ),
    )
    .where(
      and(
        eq(customerSessions.id, tokenId(token)),
        eq(customerSessions.tenantId, tenantId),
        isNull(customerSessions.revokedAt),
        gt(customerSessions.expiresAt, new Date()),
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/** Revoke one session by its raw token. No-op if it is already revoked. */
export async function revokeCustomerSessionToken(token: string): Promise<void> {
  await ownerDb
    .update(customerSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(customerSessions.id, tokenId(token)), isNull(customerSessions.revokedAt)))
}

/**
 * Issue a session for a verified customer and set the httpOnly cookie.
 *
 * Rotates like createSession(): any token already in the jar is revoked first,
 * so a token fixated by an attacker before login — or simply left over from a
 * previous customer on a shared device — cannot stay valid alongside the new
 * one.
 */
export async function createCustomerSession(input: {
  tenantId: string
  customerId: string
}): Promise<void> {
  const jar = await cookies()

  const { token, expiresAt } = await issueCustomerSession({
    tenantId: input.tenantId,
    customerId: input.customerId,
    previousToken: jar.get(COOKIE)?.value ?? null,
  })

  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
}

/**
 * Resolve the logged-in customer for THIS subdomain's tenant, or null.
 *
 * The tenant comes from the host, never from the cookie: see
 * lookupCustomerSession() for why that predicate carries real weight.
 *
 * Wrapped in React cache() so repeated calls in one request hit the DB once.
 */
export const getCurrentCustomer = cache(async function getCurrentCustomer(): Promise<CurrentCustomer | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null

  const slug = await currentTenantSlug()
  if (!slug) return null

  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) return null

  return lookupCustomerSession(token, tenant.id)
})

/** Revoke the current customer session (DB row + cookie). */
export async function destroyCustomerSession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) {
    await revokeCustomerSessionToken(token)
  }
  jar.delete(COOKIE)
}

/**
 * Revoke every live session for one customer. Not used by login itself — it is
 * what a "sign out everywhere" control and any future account-recovery flow
 * need, and it belongs next to the rest of the session lifecycle rather than
 * being reinvented at the call site.
 */
export async function revokeAllCustomerSessions(input: {
  tenantId: string
  customerId: string
}): Promise<void> {
  await ownerDb
    .update(customerSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(customerSessions.tenantId, input.tenantId),
        eq(customerSessions.customerId, input.customerId),
        isNull(customerSessions.revokedAt),
      ),
    )
}

/** Housekeeping for expired/revoked rows. Owner connection, safe to run anytime. */
export async function pruneCustomerSessions(): Promise<void> {
  await ownerDb.execute(sql`
    delete from public.customer_sessions
     where expires_at < now() - interval '7 days'
        or revoked_at < now() - interval '7 days'
  `)
}
