import type { Config } from 'drizzle-kit'

/**
 * drizzle-kit config — used for `drizzle-kit studio` (schema browser) and type
 * introspection. Migrations themselves are authoritative SQL in db/migrations,
 * applied by scripts/migrate.ts as the OWNER role (they create roles, functions,
 * RLS policies and grants that a schema-diff tool can't express).
 */
export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL ?? '',
  },
} satisfies Config
