import 'server-only'
import { asc, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { resourceSetupImages } from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/** Max photos per setup — mirrors the CHECK (position between 1 and 3) in migration 0113. */
export const MAX_SETUP_IMAGES = 3

/**
 * Photo URLs per setup id, cover (position 1) first — ONE query for any number
 * of setups, so callers never go N+1. Runs in whatever RLS context `tx` has:
 * staff see their tenant's images, the public role only those of active setups.
 * Setups without photos are simply absent from the map.
 */
export async function loadSetupImages(tx: Db, setupIds: string[]): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>()
  if (setupIds.length === 0) return byId
  const rows = await tx
    .select({ setupId: resourceSetupImages.setupId, url: resourceSetupImages.url })
    .from(resourceSetupImages)
    .where(inArray(resourceSetupImages.setupId, setupIds))
    .orderBy(asc(resourceSetupImages.setupId), asc(resourceSetupImages.position))
  for (const r of rows) {
    const list = byId.get(r.setupId) ?? []
    list.push(r.url)
    byId.set(r.setupId, list)
  }
  return byId
}
