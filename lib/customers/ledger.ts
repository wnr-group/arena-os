/**
 * Wallet and loyalty balances — always DERIVED, never stored.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { walletTransactions, loyaltyTransactions } from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * Current wallet balance for a customer, in the tenant's currency
 */
export async function walletBalance(
  tx: Db,
  tenantId: string,
  customerId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)` })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.tenantId, tenantId),
        eq(walletTransactions.customerId, customerId),
      ),
    )
  return Number(row?.total ?? 0)
}

/**
 * Current loyalty points for a customer. Positive entries are earned, negative
 * are redeemed. Returns 0 when the customer has no ledger entries.
 */
export async function loyaltyPoints(
  tx: Db,
  tenantId: string,
  customerId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${loyaltyTransactions.points}), 0)` })
    .from(loyaltyTransactions)
    .where(
      and(
        eq(loyaltyTransactions.tenantId, tenantId),
        eq(loyaltyTransactions.customerId, customerId),
      ),
    )
  return Number(row?.total ?? 0)
}
