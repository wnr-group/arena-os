import 'server-only'
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { withUser } from '@/db'
import { income } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'

/**
 * The Other income ledger's reads (M40 / AROS-357). Mirrors lib/expenses/data.ts.
 *
 * The total is summed in Postgres over the SAME predicate as the row query and
 * stays a string end to end — money never passes through a JS float. Every query
 * runs through withUser() so RLS decides which rows exist; the explicit
 * tenant_id predicate is a second lock and the index hint.
 */

export type IncomeListItem = {
  id: string
  /** `YYYY-MM-DD`, the day the money was received. */
  receivedOn: string
  /** numeric(10,2) as a STRING — never converted to a float. */
  amount: string
  note: string | null
}

export type IncomeFilters = {
  /** `YYYY-MM-DD`, inclusive. */
  from?: string
  /** `YYYY-MM-DD`, inclusive. */
  to?: string
}

export type IncomeList = {
  rows: IncomeListItem[]
  /** Σ amount over the SAME filters, summed by Postgres. String, 2dp. */
  total: string
  count: number
}

function whereFor(tenantId: string, f: IncomeFilters): SQL | undefined {
  return and(
    eq(income.tenantId, tenantId),
    f.from ? gte(income.receivedOn, f.from) : undefined,
    f.to ? lte(income.receivedOn, f.to) : undefined,
  )
}

export async function listIncome(ctx: ActiveContext, f: IncomeFilters = {}): Promise<IncomeList> {
  // Same plan toggle as Expenses — no separate income entitlement.
  await requireEntitlement(ctx, 'module.expenses')

  const where = whereFor(ctx.tenant.id, f)

  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: income.id,
        receivedOn: income.receivedOn,
        amount: income.amount,
        note: income.note,
      })
      .from(income)
      .where(where)
      .orderBy(desc(income.receivedOn), desc(income.createdAt))

    // coalesce so an empty result is '0.00', not null.
    const [agg] = await tx
      .select({
        total: sql<string>`coalesce(sum(${income.amount}), 0)::numeric(12,2)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(income)
      .where(where)

    return { rows, total: agg?.total ?? '0.00', count: agg?.count ?? 0 }
  })
}
