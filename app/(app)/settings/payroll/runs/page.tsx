import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { isOwner } from '@/lib/auth/roles'
import { todayInZone } from '@/lib/booking/time'
import { listPayrollPeriods, listPayslipsForPeriod } from '@/lib/payroll/payslips'
import { PayrollRunsManager } from '@/components/settings/PayrollRunsManager'

type Search = { period?: string }

function isValidPeriod(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}$/.test(s)
}

export default async function PayrollRunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — runPayrollForPeriod() calls requireOwner() itself, and
  // the payslips_owner_rw RLS policy is owner-only on top of that.
  if (!isOwner(ctx.role)) redirect('/dashboard')
  // Plan gate (M16 #2). PRESENTATION ONLY — the readers below and every
  // action in this module call requireEntitlement() themselves and throw.
  // This only turns that refusal into a redirect instead of an error page.
  if (!(await hasEntitlement(ctx, 'module.payroll'))) redirect('/dashboard')

  const sp = await searchParams
  const currentPeriod = todayInZone(ctx.tenant.timezone).slice(0, 7)
  const period = isValidPeriod(sp.period) ? sp.period : currentPeriod

  const [periods, payslips] = await Promise.all([listPayrollPeriods(ctx), listPayslipsForPeriod(ctx, period)])

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Payroll Runs</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Run payroll for a month — net pay is computed from salary structures, attendance and advance recoveries.
        Owner only.
      </p>
      <PayrollRunsManager
        period={period}
        currentPeriod={currentPeriod}
        periods={periods}
        payslips={payslips}
        currency={ctx.tenant.currency}
      />
    </div>
  )
}
