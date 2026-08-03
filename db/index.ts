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
type DB = NodePgDatabase<typeof schema>

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

export { schema }
