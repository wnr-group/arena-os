import 'server-only'
import { ownerDb } from '@/db'
import { describeError, enqueueNewOrderTicketOnce } from './jobs'

/**
 * Print a just-accepted online order's kitchen ticket as the system.
 *
 * The anonymous public order path runs under the public-tenant RLS context, and
 * print_jobs_insert admits only a member of the tenant, so the enqueue happens
 * here on the owner connection, in its own transaction AFTER the order has
 * committed. Best-effort and at most once per order: it never throws, so a
 * printing problem can neither fail the order nor print it twice on a retry.
 */
export async function printAcceptedOnlineOrder(tenantId: string, orderId: string): Promise<void> {
  try {
    await ownerDb.transaction((tx) => enqueueNewOrderTicketOnce(tx, tenantId, orderId))
  } catch (e) {
    console.error('[printing] online order print failed:', describeError(e))
  }
}
