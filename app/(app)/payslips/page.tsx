import Link from 'next/link'
import { FileText } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { listMyPayslips } from '@/lib/payroll/payslips'
import { formatMoney, formatPayrollPeriod } from '@/lib/format'

export default async function MyPayslipsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null

  // RLS (payslips_self_select, migration 0030) already scopes this to the
  // caller's own membership_id — the explicit filter in listMyPayslips is
  // belt-and-suspenders, not the security boundary.
  const rows = await listMyPayslips(ctx)
  const money = (n: string) => formatMoney(Number(n), ctx.tenant.currency)

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">My Payslips</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Payslips generated for you by a payroll run, most recent first.
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 text-right font-medium">Attendance</th>
                <th className="px-4 py-3 text-right font-medium">Net Pay</th>
                <th className="px-4 py-3 text-right font-medium">Payslip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No payslips yet. They appear here once a payroll run covers you.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{formatPayrollPeriod(row.period)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {row.daysPresent}/{row.daysInPeriod}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(row.netPay)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/payslips/${row.id}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      <FileText size={14} /> View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
