import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { floorSections, resources } from '@/db/schema'
import { effectiveServerId } from './rules'

type Db = NodePgDatabase<typeof schema>

/**
 * The server to stamp on a session seated at `resourceId`: the table's own
 * assignment, else its section's, else null (nobody assigned — every
 * restaurant that never set up sections lands here and behaves as before).
 * Kept free of the booking service's imports so the service can call it.
 */
export async function resolveTableServer(tx: Db, tenantId: string, resourceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ tableServer: resources.assignedServerId, sectionServer: floorSections.assignedServerId })
    .from(resources)
    .leftJoin(floorSections, eq(floorSections.id, resources.sectionId))
    .where(and(eq(resources.tenantId, tenantId), eq(resources.id, resourceId)))
    .limit(1)
  return row ? effectiveServerId(row.tableServer, row.sectionServer) : null
}
