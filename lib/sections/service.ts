/**
 * Floor sections + server assignment — the transactional core (M20 / AROS-178).
 *
 * Config (sections, table → section, section/table → server) is owner/manager
 * only (RLS agrees). The server a SESSION carries is a snapshot stamped at
 * seating (see resolveTableServer); changing an assignment never rewrites
 * history, and a mid-shift hand-off moves only OPEN sessions that haven't had
 * their bill requested (whoever handled the bill keeps the credit).
 */
import 'server-only'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookings, floorSections, memberships, resources, resourceTypes } from '@/db/schema'
import { BookingError } from '@/lib/booking/service'
import { canBeServer, validateSectionName } from './rules'

type Db = NodePgDatabase<typeof schema>
export type SectionActor = { tenantId: string; membershipId: string | null }

async function audit(tx: Db, a: SectionActor, action: string, entityType: string, entityId: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action,
    entityType,
    entityId,
    before,
    after,
  })
}

/** An active member who can wait tables, in this tenant. */
async function requireServer(tx: Db, tenantId: string, membershipId: string): Promise<{ id: string; name: string | null }> {
  const [m] = await tx
    .select({ id: memberships.id, role: memberships.role, status: memberships.status, name: memberships.fullName })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
    .limit(1)
  if (!m || m.status !== 'active') throw new BookingError('That team member isn’t active.')
  if (!canBeServer(m.role)) throw new BookingError('Kitchen staff can’t be assigned as a server.')
  return { id: m.id, name: m.name }
}

async function requireTable(tx: Db, tenantId: string, resourceId: string) {
  const [t] = await tx
    .select({ id: resources.id, branchId: resources.branchId, name: resources.name, hourlyRate: resourceTypes.hourlyRate, sectionId: resources.sectionId, serverId: resources.assignedServerId })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)))
    .limit(1)
  if (!t) throw new BookingError('Table not found.')
  if (Number(t.hourlyRate) !== 0) throw new BookingError('This resource isn’t set up as a table.')
  return t
}

async function requireSection(tx: Db, tenantId: string, sectionId: string) {
  const [s] = await tx
    .select()
    .from(floorSections)
    .where(and(eq(floorSections.id, sectionId), eq(floorSections.tenantId, tenantId)))
    .limit(1)
  if (!s) throw new BookingError('Section not found.')
  return s
}

// ── sections ────────────────────────────────────────────────────────────────

export async function createSectionCore(tx: Db, a: SectionActor, input: { branchId: string; name: string }): Promise<{ id: string }> {
  const problem = validateSectionName(input.name)
  if (problem) throw new BookingError(problem)
  const [{ n }] = await tx
    .select({ n: sql<number>`coalesce(max(${floorSections.sortOrder}), -1) + 1` })
    .from(floorSections)
    .where(and(eq(floorSections.tenantId, a.tenantId), eq(floorSections.branchId, input.branchId)))
  const [row] = await tx
    .insert(floorSections)
    .values({ tenantId: a.tenantId, branchId: input.branchId, name: input.name.trim(), sortOrder: Number(n) })
    .returning({ id: floorSections.id })
  await audit(tx, a, 'floor_section.created', 'floor_section', row.id, {}, { name: input.name.trim() })
  return row
}

export async function renameSectionCore(tx: Db, a: SectionActor, sectionId: string, name: string): Promise<void> {
  const problem = validateSectionName(name)
  if (problem) throw new BookingError(problem)
  const s = await requireSection(tx, a.tenantId, sectionId)
  await tx.update(floorSections).set({ name: name.trim() }).where(and(eq(floorSections.id, s.id), eq(floorSections.tenantId, a.tenantId)))
  await audit(tx, a, 'floor_section.renamed', 'floor_section', s.id, { name: s.name }, { name: name.trim() })
}

/** Tables in a deleted section fall back to "unsectioned" (FK set null); sessions are untouched. */
export async function deleteSectionCore(tx: Db, a: SectionActor, sectionId: string): Promise<void> {
  const s = await requireSection(tx, a.tenantId, sectionId)
  await tx.delete(floorSections).where(and(eq(floorSections.id, s.id), eq(floorSections.tenantId, a.tenantId)))
  await audit(tx, a, 'floor_section.deleted', 'floor_section', s.id, { name: s.name }, {})
}

export async function setTableSectionCore(tx: Db, a: SectionActor, resourceId: string, sectionId: string | null): Promise<void> {
  const t = await requireTable(tx, a.tenantId, resourceId)
  if (sectionId) {
    const s = await requireSection(tx, a.tenantId, sectionId)
    if (s.branchId !== t.branchId) throw new BookingError('That section belongs to a different branch.')
  }
  await tx.update(resources).set({ sectionId }).where(and(eq(resources.id, t.id), eq(resources.tenantId, a.tenantId)))
  await audit(tx, a, 'table.section_changed', 'resource', t.id, { sectionId: t.sectionId }, { sectionId })
}

// ── server assignment ───────────────────────────────────────────────────────

/** Open sessions on these tables whose bill hasn't been requested yet. */
async function handOffOpenSessions(tx: Db, tenantId: string, tableIds: string[], toServerId: string | null, onlyFrom?: string): Promise<number> {
  if (tableIds.length === 0) return 0
  const moved = await tx
    .update(bookings)
    .set({ serverId: toServerId })
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        inArray(bookings.resourceId, tableIds),
        inArray(bookings.status, ['confirmed', 'checked_in']),
        isNull(bookings.billRequestedAt),
        onlyFrom ? eq(bookings.serverId, onlyFrom) : undefined,
      ),
    )
    .returning({ id: bookings.id })
  return moved.length
}

/** Tables a section's server applies to: those without their own table-level server. */
async function sectionDefaultTableIds(tx: Db, tenantId: string, sectionId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.tenantId, tenantId), eq(resources.sectionId, sectionId), isNull(resources.assignedServerId)))
  return rows.map((r) => r.id)
}

export async function setSectionServerCore(
  tx: Db,
  a: SectionActor,
  sectionId: string,
  serverId: string | null,
  opts: { handOffOpenSessions?: boolean } = {},
): Promise<{ movedSessions: number }> {
  const s = await requireSection(tx, a.tenantId, sectionId)
  if (serverId) await requireServer(tx, a.tenantId, serverId)
  await tx.update(floorSections).set({ assignedServerId: serverId }).where(and(eq(floorSections.id, s.id), eq(floorSections.tenantId, a.tenantId)))
  await audit(tx, a, 'floor_section.server_changed', 'floor_section', s.id, { serverId: s.assignedServerId }, { serverId })
  const moved = opts.handOffOpenSessions
    ? await handOffOpenSessions(tx, a.tenantId, await sectionDefaultTableIds(tx, a.tenantId, s.id), serverId)
    : 0
  return { movedSessions: moved }
}

export async function setTableServerCore(
  tx: Db,
  a: SectionActor,
  resourceId: string,
  serverId: string | null,
  opts: { handOffOpenSessions?: boolean } = {},
): Promise<{ movedSessions: number }> {
  const t = await requireTable(tx, a.tenantId, resourceId)
  if (serverId) await requireServer(tx, a.tenantId, serverId)
  await tx.update(resources).set({ assignedServerId: serverId }).where(and(eq(resources.id, t.id), eq(resources.tenantId, a.tenantId)))
  await audit(tx, a, 'table.server_changed', 'resource', t.id, { serverId: t.serverId }, { serverId })
  // Clearing the override hands the table back to its section's server.
  let target = serverId
  if (!target && t.sectionId) {
    const s = await requireSection(tx, a.tenantId, t.sectionId)
    target = s.assignedServerId
  }
  return { movedSessions: opts.handOffOpenSessions ? await handOffOpenSessions(tx, a.tenantId, [t.id], target) : 0 }
}

/**
 * "A server goes home": everything `fromId` covers — sections, individual
 * tables, and their open sessions — moves to `toId` (or to nobody).
 */
export async function handOffServerCore(
  tx: Db,
  a: SectionActor,
  fromId: string,
  toId: string | null,
): Promise<{ sections: number; tables: number; sessions: number }> {
  if (toId === fromId) throw new BookingError('Pick a different server to hand off to.')
  if (toId) await requireServer(tx, a.tenantId, toId)

  const secs = await tx
    .update(floorSections)
    .set({ assignedServerId: toId })
    .where(and(eq(floorSections.tenantId, a.tenantId), eq(floorSections.assignedServerId, fromId)))
    .returning({ id: floorSections.id })
  const tabs = await tx
    .update(resources)
    .set({ assignedServerId: toId })
    .where(and(eq(resources.tenantId, a.tenantId), eq(resources.assignedServerId, fromId)))
    .returning({ id: resources.id })

  // Open sessions currently carried by `from`, wherever they sit (a party may
  // have been hand-seated outside the assigned tables).
  const sessions = await tx
    .update(bookings)
    .set({ serverId: toId })
    .where(
      and(
        eq(bookings.tenantId, a.tenantId),
        eq(bookings.serverId, fromId),
        inArray(bookings.status, ['confirmed', 'checked_in']),
        isNull(bookings.billRequestedAt),
        // table sessions only
        isNotNull(bookings.resourceId),
      ),
    )
    .returning({ id: bookings.id })

  await audit(tx, a, 'floor.server_handoff', 'membership', fromId, { serverId: fromId }, {
    serverId: toId,
    sections: secs.length,
    tables: tabs.length,
    sessions: sessions.length,
  })
  return { sections: secs.length, tables: tabs.length, sessions: sessions.length }
}

/** Remove every section/table assignment (end of shift). Open sessions keep their stamped server. */
export async function clearAssignmentsCore(tx: Db, a: SectionActor): Promise<{ sections: number; tables: number }> {
  const secs = await tx
    .update(floorSections)
    .set({ assignedServerId: null })
    .where(eq(floorSections.tenantId, a.tenantId))
    .returning({ id: floorSections.id, s: floorSections.assignedServerId })
  const tabs = await tx
    .update(resources)
    .set({ assignedServerId: null })
    .where(and(eq(resources.tenantId, a.tenantId), sql`${resources.assignedServerId} is not null`))
    .returning({ id: resources.id })
  await audit(tx, a, 'floor.assignments_cleared', 'tenant', a.tenantId, {}, { sections: secs.length, tables: tabs.length })
  return { sections: secs.length, tables: tabs.length }
}

/** Reassign one running session (a front-of-house role may do this from the floor). */
export async function setSessionServerCore(tx: Db, a: SectionActor, bookingId: string, serverId: string | null): Promise<void> {
  const [b] = await tx
    .select({ id: bookings.id, status: bookings.status, resourceId: bookings.resourceId, serverId: bookings.serverId })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, a.tenantId)))
    .for('update')
    .limit(1)
  if (!b || !b.resourceId) throw new BookingError('Table session not found.')
  if (b.status !== 'checked_in' && b.status !== 'confirmed') throw new BookingError('This session is already closed.')
  if (serverId) await requireServer(tx, a.tenantId, serverId)
  await tx.update(bookings).set({ serverId }).where(and(eq(bookings.id, b.id), eq(bookings.tenantId, a.tenantId)))
  await audit(tx, a, 'table_session.server_changed', 'booking', b.id, { serverId: b.serverId }, { serverId })
}
