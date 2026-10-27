import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { floorSections, memberships, resourceTypes, resources } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { SERVER_ROLES } from './rules'

export type ServerOption = { id: string; name: string }

/** Active team members who can be a table's server. */
export function listServers(ctx: ActiveContext): Promise<ServerOption[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ id: memberships.id, name: memberships.fullName, email: memberships.email })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.status, 'active'),
          inArray(memberships.role, [...SERVER_ROLES]),
        ),
      )
      .orderBy(asc(memberships.fullName))
    return rows.map((r) => ({ id: r.id, name: r.name ?? r.email ?? 'Team member' }))
  })
}

export type SectionConfig = {
  sections: { id: string; name: string; assignedServerId: string | null }[]
  tables: { id: string; name: string; sectionId: string | null; assignedServerId: string | null }[]
}

export function getSectionConfig(ctx: ActiveContext, branchId: string): Promise<SectionConfig> {
  return withUser(ctx.user.id, async (tx) => {
    const sections = await tx
      .select({ id: floorSections.id, name: floorSections.name, assignedServerId: floorSections.assignedServerId })
      .from(floorSections)
      .where(and(eq(floorSections.tenantId, ctx.tenant.id), eq(floorSections.branchId, branchId)))
      .orderBy(asc(floorSections.sortOrder), asc(floorSections.name))
    const tables = await tx
      .select({ id: resources.id, name: resources.name, sectionId: resources.sectionId, assignedServerId: resources.assignedServerId })
      .from(resources)
      .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
      .where(and(eq(resources.tenantId, ctx.tenant.id), eq(resources.branchId, branchId), eq(resourceTypes.hourlyRate, '0')))
      .orderBy(asc(resources.sortOrder), asc(resources.name))
    return { sections, tables }
  })
}
