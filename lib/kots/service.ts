/**
 * Advancing a kitchen ticket through its status flow — the transactional core
 * behind the kitchen dashboard's buttons.
 *
 * Takes a `tx`, same pattern as lib/orders/service.ts and lib/billing/invoice.ts.
 */
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { kots } from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

export type KotStatus = 'pending' | 'preparing' | 'ready' | 'served' | 'cancelled'

/** Ticket status flow violations the caller is allowed to show verbatim. */
export class KotError extends Error {}

/**
 * Legal forward moves through the kitchen workflow: pending → preparing →
 * ready → served. `cancelled` is reachable from any active state (a voided
 * order, a kitchen mistake); nothing is legal out of a terminal state
 * (`served`, `cancelled`) — a served ticket can never go back to pending.
 */
export const KOT_TRANSITIONS: Record<KotStatus, KotStatus[]> = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'cancelled'],
  served: [],
  cancelled: [],
}

export async function updateKotStatusCore(
  tx: Db,
  ctx: { tenantId: string },
  kotId: string,
  newStatus: KotStatus,
): Promise<void> {
  const [kot] = await tx
    .select({ status: kots.status })
    .from(kots)
    .where(and(eq(kots.id, kotId), eq(kots.tenantId, ctx.tenantId)))
    .for('update')
    .limit(1)
  if (!kot) throw new KotError('Ticket not found.')

  if (!KOT_TRANSITIONS[kot.status].includes(newStatus)) {
    throw new KotError(`Cannot move a ${kot.status} ticket to ${newStatus}.`)
  }

  await tx
    .update(kots)
    .set({ status: newStatus })
    .where(and(eq(kots.id, kotId), eq(kots.tenantId, ctx.tenantId)))
}
