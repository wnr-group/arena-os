import 'server-only'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from './schema'

/**
 * Two database handles, mirroring the two Postgres roles (see .env.example):
 *
 *   ownerDb — connects as the privileged owner role (BYPASSES RLS). Migrations,
 *             seeding, tenant provisioning, and auth/session/user lookups only.
 *
 *   appDb   — connects as `arena_app` (NO BYPASSRLS). NEVER query it directly for
 *             tenant data; go through withUser(), which opens a transaction and
 *             sets `app.user_id` so RLS scopes every row to the caller's tenants.
 *
 * Pools are cached on globalThis so dev HMR doesn't leak connections.
 */
/**
 * The Drizzle handle every wrapper below hands to its callback. Exported so a
 * reader can declare "I take an already-scoped transaction" in its signature
 * (see lib/portal/bookings.ts) rather than taking an id it would have to trust.
 */
export type DB = NodePgDatabase<typeof schema>

const globalForDb = globalThis as unknown as {
  __ownerPool?: Pool
  __appPool?: Pool
}

function ownerPool(): Pool {
  if (!globalForDb.__ownerPool) {
    globalForDb.__ownerPool = new Pool({
      connectionString: process.env.DATABASE_URL_OWNER,
    })
  }
  return globalForDb.__ownerPool
}

function appPool(): Pool {
  if (!globalForDb.__appPool) {
    globalForDb.__appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return globalForDb.__appPool
}

export const ownerDb: DB = drizzle(ownerPool(), { schema })
const appDb: DB = drizzle(appPool(), { schema })

/**
 * Run tenant-scoped work as a specific user with RLS enforced.
 *
 * Opens a transaction on the restricted app connection, sets `app.user_id` for
 * the life of that transaction (set_config(..., is_local => true)), then hands a
 * transaction-bound Drizzle instance to the callback. Because `arena_app` cannot
 * bypass RLS, any query that reaches beyond the user's tenants simply returns no
 * rows — the isolation guarantee holds even if app code forgets to filter.
 */
export async function withUser<T>(userId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx as unknown as DB)
  })
}

/**
 * Run UN-authenticated work on the restricted app connection — the public
 * booking site. No app.user_id is ever set here, so every staff-only RLS
 * policy (keyed off auth_tenant_ids()) simply matches nothing; only the
 * `*_public_select` policies (0022_public_booking.sql) apply.
 *
 * withPublicApp: no tenant known yet — legal only for the slug-to-tenant
 * lookup, which goes through the public_tenant_by_slug() SECURITY DEFINER
 * function (0022_public_booking.sql) rather than a row policy, since a
 * broad tenants SELECT policy would let any caller enumerate every tenant
 * on the platform.
 * withPublicTenant: pins one already-resolved tenant id for the life of the
 * transaction, the same way withUser() pins a user.
 */
export async function withPublicApp<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
  return appDb.transaction((tx) => fn(tx as unknown as DB))
}

export async function withPublicTenant<T>(tenantId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
    return fn(tx as unknown as DB)
  })
}

/**
 * Run work as a LOGGED-IN CUSTOMER on the customer portal, with RLS enforced.
 *
 * The third identity on this connection, alongside withUser() (staff) and
 * withPublicTenant() (anonymous visitor). It sets `app.customer_id` for the
 * life of one transaction, and the customer policies in
 * 0045_customer_portal_rls.sql then scope every row to that one customer.
 *
 * ── It sets app.customer_id and NOTHING ELSE. That is the security property ──
 *
 * Postgres RLS policies are PERMISSIVE by default, which means they are OR-ed
 * together. `customers_public_select` and `bookings_public_select`
 * (0023_public_booking_create.sql) both read
 *
 *     tenant_id = current_public_tenant_id()
 *
 * and deliberately expose EVERY customer and EVERY booking of a tenant — the
 * public booking flow needs them for the phone find-or-create and for the
 * BK-YYYYMMDD-NNN counter, and safety there rests on application-level column
 * discipline rather than on the row policy.
 *
 * So if this wrapper also pinned `app.public_tenant_id` — the obvious thing to
 * reach for, since the portal lives on a tenant subdomain — those policies
 * would OR with the customer policies and a logged-in customer would be able
 * to read the entire tenant's customer directory and booking table. The
 * customer id alone is enough: it is a globally unique primary key, and
 * current_customer_tenant_id() derives the tenant from it inside the database,
 * so the tenant is never taken from the caller.
 *
 * Two things back this up if someone later adds the pin anyway: the customer
 * policies are paired with RESTRICTIVE policies (which AND rather than OR), and
 * scripts/verify-customer-portal-rls.ts asserts the combination directly.
 *
 * The customer id must come from a validated customer session
 * (lib/auth/customer-session.ts) — never from a route param, form field or
 * header.
 */
export async function withCustomer<T>(customerId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.customer_id', ${customerId}, true)`)
    return fn(tx as unknown as DB)
  })
}

export { schema }
