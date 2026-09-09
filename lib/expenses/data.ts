import 'server-only'
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { withUser } from '@/db'
import { expenseCategories, expenses, vendors } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'

/**
 * The Expenses page's reads (AROS-108).
 *
 * ── THE TOTAL IS SUMMED IN POSTGRES, NOT IN JAVASCRIPT ──────────────────────
 * `sum(amount)` runs in the database over the SAME predicate as the row query,
 * so the figure on screen always describes exactly the rows under it — and a
 * future page of 10,000 expenses costs one aggregate, not 10,000 rows pulled
 * into memory. It comes back as `::text` and stays a string all the way to the
 * formatter: `amount` is numeric(10,2), and routing money through a JS float is
 * the one thing this codebase never does (same rule as capturedTotal() in
 * lib/billing/payments.ts).
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * Every query goes through withUser(), so RLS decides which rows exist; the
 * explicit tenant_id predicate is a second lock and the index hint that lands
 * these on idx_expenses_tenant_spent_on. The filter values come from the URL
 * and are therefore untrusted — but a category or vendor id belonging to
 * another tenant simply matches nothing, because the tenant predicate and RLS
 * are ANDed with it. There is no id the browser can supply that widens the
 * result set.
 */

export type ExpenseListItem = {
  id: string
  /** `YYYY-MM-DD`, the day the money was spent. */
  spentOn: string
  /** numeric(10,2) as a STRING — never converted to a float. */
  amount: string
  note: string | null
  /** The stored S3 URL, or null when no receipt is attached (AROS-110). */
  receiptUrl: string | null
  categoryId: string
  categoryName: string
  vendorId: string | null
  vendorName: string | null
}

export type ExpenseFilters = {
  /** `YYYY-MM-DD`, inclusive. */
  from?: string
  /** `YYYY-MM-DD`, inclusive. */
  to?: string
  categoryId?: string
  vendorId?: string
}

export type ExpenseList = {
  rows: ExpenseListItem[]
  /** Σ amount over the SAME filters, summed by Postgres. String, 2dp. */
  total: string
  count: number
}

export type OptionRow = { id: string; name: string }

/** The filter predicate, shared by the row query and the aggregate so the two
 *  can never describe different sets. */
function whereFor(tenantId: string, f: ExpenseFilters): SQL | undefined {
  return and(
    eq(expenses.tenantId, tenantId),
    f.from ? gte(expenses.spentOn, f.from) : undefined,
    f.to ? lte(expenses.spentOn, f.to) : undefined,
    f.categoryId ? eq(expenses.categoryId, f.categoryId) : undefined,
    f.vendorId ? eq(expenses.vendorId, f.vendorId) : undefined,
  )
}

/**
 * The filtered rows plus their total, in one RLS-scoped transaction so both
 * see the same snapshot.
 */
export async function listExpenses(ctx: ActiveContext, f: ExpenseFilters = {}): Promise<ExpenseList> {
  // Module gate (M16 #2). Authoritative for READS — the page redirect is
  // presentation only; this is what a plan without Expenses actually blocks.
  await requireEntitlement(ctx, 'module.expenses')

  const where = whereFor(ctx.tenant.id, f)

  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: expenses.id,
        spentOn: expenses.spentOn,
        amount: expenses.amount,
        note: expenses.note,
        receiptUrl: expenses.receiptUrl,
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        vendorId: expenses.vendorId,
        vendorName: vendors.name,
      })
      .from(expenses)
      // Inner on the category (it is NOT NULL and restrict-protected, so a row
      // always has one); left on the vendor, which is optional and may have
      // been deleted out from under the expense.
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
      .where(where)
      .orderBy(desc(expenses.spentOn), desc(expenses.createdAt))

    // Same predicate, aggregated in the database. coalesce so an empty result
    // is '0.00' rather than null — "no expenses" is a total of zero.
    const [agg] = await tx
      .select({
        total: sql<string>`coalesce(sum(${expenses.amount}), 0)::numeric(12,2)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(expenses)
      .where(where)

    return { rows, total: agg?.total ?? '0.00', count: agg?.count ?? 0 }
  })
}

/** Active categories for the selector — this tenant's only, RLS-scoped. */
export async function listExpenseCategoryOptions(ctx: ActiveContext): Promise<OptionRow[]> {
  await requireEntitlement(ctx, 'module.expenses')

  return withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: expenseCategories.id, name: expenseCategories.name })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.tenantId, ctx.tenant.id), eq(expenseCategories.isActive, true)))
      .orderBy(asc(expenseCategories.name)),
  )
}

/** Active vendors for the selector — this tenant's only, RLS-scoped. */
export async function listVendorOptions(ctx: ActiveContext): Promise<OptionRow[]> {
  await requireEntitlement(ctx, 'module.expenses')

  return withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.tenantId, ctx.tenant.id), eq(vendors.isActive, true)))
      .orderBy(asc(vendors.name)),
  )
}
