import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import {
  listExpenses,
  listExpenseCategoryOptions,
  listVendorOptions,
  type ExpenseFilters,
} from '@/lib/expenses/data'
import { ExpensesView } from '@/components/expenses/ExpensesView'

type Search = { from?: string; to?: string; category?: string; vendor?: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Junk in the query string is ignored rather than surfaced as an error — a
 *  hand-edited URL should show the unfiltered page, not a stack trace. A value
 *  that survives this is still only a filter: it is ANDed with the tenant
 *  predicate and RLS, so it can never widen the result set. */
const asDate = (v?: string) => (v && DATE_RE.test(v) ? v : undefined)
const asId = (v?: string) => (v && UUID_RE.test(v) ? v : undefined)

/**
 * Expenses (AROS-108) — manager-guarded, like every other settings-shaped page.
 *
 * The guard here is presentation only: it keeps the page off a cashier's screen
 * and out of their nav. The real boundary is in lib/actions/expenses.ts
 * (requireManager) and in the expenses_write RLS policy, both of which refuse a
 * non-manager calling the mutations directly.
 *
 * Filters live in the URL (?from=&to=&category=&vendor=) exactly as the
 * customers list does, so a filtered view is linkable and the back button
 * works. They are applied — and the total summed — in Postgres; see
 * lib/expenses/data.ts.
 */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null // the layout already guards a missing session
  if (!isManager(ctx.role)) redirect('/dashboard')

  const sp = await searchParams
  const filters: ExpenseFilters = {
    from: asDate(sp.from),
    to: asDate(sp.to),
    categoryId: asId(sp.category),
    vendorId: asId(sp.vendor),
  }

  // Sequential, not Promise.all: each opens its own withUser() transaction on
  // the shared app pool, and three small reads gain nothing from competing for
  // it.
  const list = await listExpenses(ctx, filters)
  const categories = await listExpenseCategoryOptions(ctx)
  const vendors = await listVendorOptions(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Expenses</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        What {ctx.tenant.name} spent — filter by date, category or vendor. Owner and manager only.
      </p>

      <ExpensesView
        rows={list.rows}
        total={list.total}
        count={list.count}
        categories={categories}
        vendors={vendors}
        currency={ctx.tenant.currency}
        timeZone={ctx.tenant.timezone}
        filters={{
          from: filters.from ?? '',
          to: filters.to ?? '',
          category: filters.categoryId ?? '',
          vendor: filters.vendorId ?? '',
        }}
      />
    </div>
  )
}
