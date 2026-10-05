/**
 * Reading a booking's advance from the advance_payments ledger (M30 #4).
 *
 * Mirrors lib/customers/ledger.ts's walletBalance(): the advance collected is
 * always DERIVED by summing the ledger live, never stored as a cached total
 * (bookings.advance_paid / advance_applied are superseded history, unread).
 *
 * No `import 'server-only'` — takes a `tx`, opens no connection, like the
 * other billing helpers.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { advancePayments } from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/** Total advance collected for one booking, in rupees — every tender, consumed or not. */
export async function advancePaidTotal(tx: Db, tenantId: string, bookingId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${advancePayments.amount}), 0)` })
    .from(advancePayments)
    .where(and(eq(advancePayments.tenantId, tenantId), eq(advancePayments.bookingId, bookingId)))
  return Number(row?.total ?? 0)
}

/**
 * Totals for many bookings in ONE grouped query (load once, not per row).
 * Bookings with no tender are absent from the map — read them as '0.00'.
 */
export async function advancePaidTotals(
  tx: Db,
  tenantId: string,
  bookingIds: string[],
): Promise<Map<string, string>> {
  if (bookingIds.length === 0) return new Map()
  const rows = await tx
    .select({
      bookingId: advancePayments.bookingId,
      total: sql<string>`coalesce(sum(${advancePayments.amount}), 0)::numeric(10,2)::text`,
    })
    .from(advancePayments)
    .where(and(eq(advancePayments.tenantId, tenantId), inArray(advancePayments.bookingId, bookingIds)))
    .groupBy(advancePayments.bookingId)
  return new Map(rows.map((r) => [r.bookingId, r.total]))
}

/** True when any tender is still unconsumed — not yet folded into an invoice's payments. */
export async function hasUnconsumedAdvance(tx: Db, tenantId: string, bookingId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: advancePayments.id })
    .from(advancePayments)
    .where(
      and(
        eq(advancePayments.tenantId, tenantId),
        eq(advancePayments.bookingId, bookingId),
        isNull(advancePayments.invoiceId),
        sql`${advancePayments.amount} > 0`,
      ),
    )
    .limit(1)
  return rows.length > 0
}
