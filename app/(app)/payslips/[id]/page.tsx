import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { getPayslipById } from '@/lib/payroll/payslips'
import { getBusinessProfile } from '@/lib/settings/business'
import { formatMoney, formatPayrollPeriod } from '@/lib/format'
import { round2 } from '@/lib/billing/pricing'
import { PrintButton } from '@/components/invoices/PrintButton'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // NO plan gate. A payslip is a record already issued to the person reading
  // it, and a business downgrading its plan must not retroactively withhold
  // one — see getPayslipById() in lib/payroll/payslips.ts for the full
  // reasoning. RLS still decides who may see this row.
  const { id } = await params
  if (!UUID.test(id)) notFound()

  // payslips_self_select / payslips_manager_select RLS (migration 0030)
  // already decide who can see this row: the employee it belongs to, or an
  // owner/manager. Anyone else's id — or an unknown one — returns null here,
  // same as the invoice receipt page: the URL leaks nothing either way.
  const [payslip, business] = await Promise.all([getPayslipById(ctx, id), getBusinessProfile(ctx)])
  if (!payslip) notFound()

  const money = (v: string) => formatMoney(v, ctx.tenant.currency)
  const allowancesTotal = payslip.allowances.reduce((sum, a) => sum + Number(a.amount), 0)

  return (
    <div className="px-4 py-6 sm:px-6">
      {/* ── screen-only action bar ── */}
      <div className="no-print mx-auto flex max-w-2xl items-center justify-between gap-3">
        <Link href="/payslips" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft size={15} /> Back
        </Link>
        <PrintButton />
      </div>

      {/* ── the payslip ── */}
      <article className="print-sheet mx-auto mt-4 max-w-2xl rounded-lg border bg-card p-6 shadow-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold uppercase tracking-wide">
              {business?.legalName || ctx.tenant.name}
            </h1>
            {business?.address && (
              <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">{business.address}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-base font-bold uppercase tracking-widest">Payslip</p>
            <p className="mt-1 text-sm text-muted-foreground">{formatPayrollPeriod(payslip.period)}</p>
          </div>
        </header>

        <section className="grid gap-5 border-b py-5 sm:grid-cols-2">
          <dl className="space-y-1 text-sm">
            <Meta k="Employee" v={payslip.fullName || payslip.email || 'Unnamed'} strong />
            {payslip.email && <Meta k="Email" v={payslip.email} />}
          </dl>
          <dl className="space-y-1 text-sm">
            <Meta k="Pay Period" v={formatPayrollPeriod(payslip.period)} />
            <Meta k="Days Present" v={`${payslip.daysPresent} of ${payslip.daysInPeriod}`} />
          </dl>
        </section>

        <section className="grid gap-6 py-5 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Earnings</p>
            <dl className="mt-2 space-y-1.5 text-sm">
              <Row k="Base" v={money(payslip.base)} />
              {payslip.allowances.map((a, i) => (
                <Row key={i} k={a.label} v={money(a.amount)} />
              ))}
              {payslip.allowances.length === 0 && (
                <p className="text-sm text-muted-foreground">No allowances</p>
              )}
              <div className="flex justify-between gap-4 border-t pt-1.5 font-semibold">
                <dt>Gross Pay</dt>
                <dd className="tabular-nums">{money(payslip.gross)}</dd>
              </div>
              {Number(payslip.daysPresent) < Number(payslip.daysInPeriod) && (
                <p className="text-xs text-muted-foreground">
                  Prorated: (base + allowances of {money(String(Number(payslip.base) + allowancesTotal))}) ×{' '}
                  {payslip.daysPresent}/{payslip.daysInPeriod} days
                </p>
              )}
            </dl>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deductions</p>
            <dl className="mt-2 space-y-1.5 text-sm">
              {payslip.deductions.map((d, i) => (
                <Row key={i} k={d.label} v={money(d.amount)} />
              ))}
              {payslip.deductions.length === 0 && (
                <p className="text-sm text-muted-foreground">No deductions</p>
              )}
              {Number(payslip.advanceInstalment) > 0 && <Row k="Advance recovery" v={money(payslip.advanceInstalment)} />}
              <div className="flex justify-between gap-4 border-t pt-1.5 font-semibold">
                <dt>Total Deductions</dt>
                <dd className="tabular-nums">
                  {money(String(round2(Number(payslip.deductionsTotal) + Number(payslip.advanceInstalment))))}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="print-keep flex justify-end border-t pt-5">
          <div className="flex w-full justify-between gap-4 rounded-lg bg-primary/5 px-4 py-3.5 text-base font-bold sm:w-72">
            <span>Net Pay</span>
            <span className="tabular-nums">{money(payslip.netPay)}</span>
          </div>
        </section>

        <footer className="mt-6 border-t pt-4 text-center text-xs text-muted-foreground">
          This is a computer-generated payslip.
        </footer>
      </article>
    </div>
  )
}

function Meta({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{k}</dt>
      <dd className={strong ? 'font-semibold' : ''}>{v}</dd>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}
