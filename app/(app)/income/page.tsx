import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { listIncome } from '@/lib/income/data'
import { resolveDateRange } from '@/lib/reports/date-range'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { IncomeView } from '@/components/income/IncomeView'

type Search = { from?: string; to?: string }

/**
 * Other income (M40 / AROS-359) — money received that is NOT a sale: owner
 * investment, bank interest, a vendor refund. Manager-guarded like Expenses.
 *
 * The guard here is presentation only. The real boundary is requireManager()
 * in lib/actions/income.ts and the income_write RLS policy.
 *
 * The range lives in the URL (?from=&to=) and is applied — and the total summed
 * — in Postgres by listIncome(). Nothing on this page feeds Revenue; only the
 * P&L statement reads this ledger.
 */
export default async function IncomePage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null // the layout already guards a missing session
  if (!isManager(ctx.role)) redirect('/dashboard')
  // Plan gate — the same module.expenses toggle covers both ledgers.
  // PRESENTATION ONLY: listIncome() and every action call requireEntitlement().
  if (!(await hasEntitlement(ctx, 'module.expenses'))) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const today = todayInZone(tz)
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })

  const list = await listIncome(ctx, { from: range.start, to: range.end })

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Other income</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Money {ctx.tenant.name} received that isn&apos;t a sale — investment, interest, refunds.
        Shown on the Profit &amp; Loss report only, never in Revenue. Owner and manager only.
      </p>

      <DateRangeFilter basePath="/income" from={range.start} to={range.end} today={today} />

      <IncomeView
        rows={list.rows}
        total={list.total}
        count={list.count}
        currency={ctx.tenant.currency}
        timeZone={tz}
        today={today}
      />
    </div>
  )
}
