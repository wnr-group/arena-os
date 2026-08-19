import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { withPublicApp } from '@/db'

export type PublicTenant = {
  id: string
  slug: string
  name: string
  industry: string
  currency: string
  timezone: string
}

/**
 * Resolve a tenant for the PUBLIC booking site from its subdomain — no
 * session, no membership check. Goes through public_tenant_by_slug()
 * (0032_public_booking.sql), a SECURITY DEFINER function rather than an RLS
 * policy: a "visible to everyone" policy on `tenants` would OR together with
 * the staff-only tenants_member_select policy and let any caller — including
 * signed-in staff — enumerate every tenant on the platform. The function
 * reads past RLS internally but only ever returns the one row matching the
 * slug you already have, and only if that tenant is 'trial'/'active'; a
 * suspended or cancelled tenant's slug resolves to null, same as an unknown
 * one.
 */
export const getPublicTenantBySlug = cache(async function getPublicTenantBySlug(
  slug: string,
): Promise<PublicTenant | null> {
  const { rows } = await withPublicApp((tx) =>
    tx.execute<PublicTenant>(sql`
      select id, slug, name, industry, currency, timezone
      from public.public_tenant_by_slug(${slug})
    `),
  )
  return rows[0] ?? null
})
