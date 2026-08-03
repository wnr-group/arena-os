import 'server-only'
import { desc, eq, sql } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { tenants, branches, memberships, users } from '@/db/schema'
import { requirePlatformAdmin } from './guard'

/**
 * Platform-admin reads. These are CROSS-TENANT by design and run on the owner
 * connection (RLS-bypassing). Because they bypass RLS, each ENFORCES the
 * platform-admin check itself — never trust the caller (a layout that hides
 * output still executes the page, so a page-only guard would leak data into the
 * RSC payload). This is the security boundary; page guards are just for UX.
 */

export async function listCompanies() {
  await requirePlatformAdmin()
  return ownerDb
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      industry: tenants.industry,
      status: tenants.status,
      createdAt: tenants.createdAt,
      memberCount: sql<number>`count(distinct ${memberships.id})`,
    })
    .from(tenants)
    .leftJoin(memberships, eq(memberships.tenantId, tenants.id))
    .groupBy(tenants.id)
    .orderBy(desc(tenants.createdAt))
}

export async function getCompany(id: string) {
  await requirePlatformAdmin()
  const [tenant] = await ownerDb.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  if (!tenant) return null

  const [branch] = await ownerDb
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(eq(branches.tenantId, id))
    .orderBy(desc(branches.isPrimary))
    .limit(1)

  const members = await ownerDb
    .select({
      id: memberships.id,
      role: memberships.role,
      status: memberships.status,
      fullName: memberships.fullName,
      email: users.email,
      userId: users.id,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, id))
    .orderBy(desc(memberships.role))

  return { tenant, branch, members }
}
