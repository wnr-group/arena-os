'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Play, Users, Wallet, HandCoins, Loader2, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { runPayrollForPeriod } from '@/lib/actions/payroll'
import { formatMoney, formatPayrollPeriod as formatPeriod } from '@/lib/format'

type SalaryComponent = { label: string; amount: string }
type PayslipRow = {
  id: string
  membershipId: string
  fullName: string | null
  email: string | null
  period: string
  base: string
  allowances: SalaryComponent[]
  deductions: SalaryComponent[]
  daysInPeriod: number
  daysPresent: number
  gross: string
  deductionsTotal: string
  advanceInstalment: string
  netPay: string
}
type PayrollPeriodSummary = { period: string; payslipCount: number; totalNetPay: number }

const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

export function PayrollRunsManager({
  period,
  currentPeriod,
  periods,
  payslips,
  currency,
}: {
  period: string
  currentPeriod: string
  periods: PayrollPeriodSummary[]
  payslips: PayslipRow[]
  currency: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const money = (n: number | string) => formatMoney(Number(n), currency)

  const alreadyRun = periods.some((p) => p.period === period)

  const totals = useMemo(() => {
    const totalNetPay = payslips.reduce((sum, p) => sum + Number(p.netPay), 0)
    const totalAdvanceRecovered = payslips.reduce((sum, p) => sum + Number(p.advanceInstalment), 0)
    return { totalNetPay, totalAdvanceRecovered }
  }, [payslips])

  function goToPeriod(next: string) {
    router.push(`/settings/payroll/runs?period=${next}`)
  }

  function handleRun() {
    setError(null)
    start(async () => {
      const r = await runPayrollForPeriod(period)
      if (r.error) {
        setError(r.error)
        toast.error(r.error)
        return
      }
      const { generated = [], skipped = [] } = r.result ?? {}
      toast.success(
        skipped.length > 0
          ? `Payroll run for ${formatPeriod(period)}: ${generated.length} payslip(s) generated, ${skipped.length} skipped (no salary structure).`
          : `Payroll run for ${formatPeriod(period)}: ${generated.length} payslip(s) generated.`,
      )
      router.refresh()
    })
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="period" className="text-xs font-medium text-muted-foreground">
            Period
          </label>
          <input
            id="period"
            type="month"
            value={period}
            max={currentPeriod}
            onChange={(e) => e.target.value && goToPeriod(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={handleRun}
          disabled={pending || alreadyRun}
          title={alreadyRun ? 'Payroll for this period has already been run.' : undefined}
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {alreadyRun ? 'Already run' : `Run payroll for ${formatPeriod(period)}`}
        </button>
      </div>

      {alreadyRun && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard icon={Users} label="Payslips" value={payslips.length} accent="bg-primary/10 text-primary" />
          <StatCard
            icon={Wallet}
            label="Total net pay"
            value={money(totals.totalNetPay)}
            accent="bg-emerald-500/10 text-emerald-600"
          />
          <StatCard
            icon={HandCoins}
            label="Advances recovered"
            value={money(totals.totalAdvanceRecovered)}
            accent="bg-amber-500/10 text-amber-600"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Payslips — {formatPeriod(period)}
        </h2>
        {periods.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {periods.slice(0, 6).map((p) => (
              <button
                key={p.period}
                onClick={() => goToPeriod(p.period)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  p.period === period
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {formatPeriod(p.period)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 text-right font-medium">Attendance</th>
                <th className="px-4 py-3 text-right font-medium">Gross</th>
                <th className="px-4 py-3 text-right font-medium">Deductions</th>
                <th className="px-4 py-3 text-right font-medium">Advance</th>
                <th className="px-4 py-3 text-right font-medium">Net Pay</th>
                <th className="px-4 py-3 text-right font-medium">Payslip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payslips.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {alreadyRun ? 'No payslips for this period.' : 'Payroll has not been run for this period yet.'}
                  </td>
                </tr>
              )}
              {payslips.map((row) => (
                <PayslipTableRow key={row.id} row={row} money={money} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function PayslipTableRow({ row, money }: { row: PayslipRow; money: (n: number | string) => string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr className="cursor-pointer transition hover:bg-muted/20" onClick={() => setOpen((o) => !o)}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 font-medium">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {row.fullName || row.email || 'Unnamed'}
          </div>
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
          {row.daysPresent}/{row.daysInPeriod}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">{money(row.gross)}</td>
        <td className="px-4 py-3 text-right tabular-nums text-destructive">{money(row.deductionsTotal)}</td>
        <td className="px-4 py-3 text-right tabular-nums text-amber-600">{money(row.advanceInstalment)}</td>
        <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(row.netPay)}</td>
        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          <Link
            href={`/payslips/${row.id}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <FileText size={14} /> View
          </Link>
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/10">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Base</p>
                <p className="mt-1 tabular-nums">{money(row.base)}</p>
              </div>
              <ComponentBreakdown label="Allowances" items={row.allowances} money={money} tone="text-emerald-600" />
              <ComponentBreakdown label="Deductions" items={row.deductions} money={money} tone="text-destructive" />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function ComponentBreakdown({
  label,
  items,
  money,
  tone,
}: {
  label: string
  items: SalaryComponent[]
  money: (n: number | string) => string
  tone: string
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {items.map((c, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="text-muted-foreground">{c.label}</span>
              <span className={`tabular-nums ${tone}`}>{money(c.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string | number
  accent: string
}) {
  return (
    <div className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110 ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
