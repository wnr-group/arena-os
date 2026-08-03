import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { and, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { tenants, memberships } from '@/db/schema'
import { getCurrentUser, type CurrentUser } from '@/lib/auth/session'
import { tenantSlugFromHost } from './subdomain'
import type { MemberRole } from '@/lib/auth/roles'

export type Tenant = {
  id: string
  slug: string
  name: string
  industry: string
  status: string
  currency: string
  timezone: string
}

export type ActiveContext = {
  user: CurrentUser
  tenant: Tenant
  role: MemberRole
  membershipId: string
  branchId: string | null
}

/** The tenant slug for the current request, from the proxy-set header. */
export async function currentTenantSlug(): Promise<string | null> {
  const h = await headers()
  return h.get('x-tenant-slug') ?? tenantSlugFromHost(h.get('host'))
}

/**
 * Resolve the active tenant AND verify the logged-in user is an active member.
 *
 * The tenant + membership reads run through withUser() on the restricted app
 * connection, so RLS enforces isolation: a non-member gets zero rows and there
 * is no way to read another tenant by guessing its subdomain. Returns null when
 * there is no session, no tenant context, or no membership.
 */
export const getActiveContext = cache(async function getActiveContext(): Promise<ActiveContext | null> {
  const user = await getCurrentUser()
  if (!user) return null

  const slug = await currentTenantSlug()
  if (!slug) return null

  return withUser(user.id, async (tx) => {
    const [tenant] = await tx
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        industry: tenants.industry,
        status: tenants.status,
        currency: tenants.currency,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1)

    if (!tenant) return null // not a member (RLS) or unknown slug

    const [membership] = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        branchId: memberships.branchId,
        status: memberships.status,
      })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id)))
      .limit(1)

    if (!membership || membership.status !== 'active') return null

    return {
      user,
      tenant: tenant as Tenant,
      role: membership.role as MemberRole,
      membershipId: membership.id,
      branchId: membership.branchId ?? null,
    }
  })
})
