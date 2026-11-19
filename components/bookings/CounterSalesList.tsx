import Link from 'next/link'
import { Printer, Wrench } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { CounterSaleRow } from '@/lib/orders/counter-data'

const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online', wallet: 'Wallet' }
const STATUS_STYLE: Record<CounterSaleRow['status'], string> = {
  paid: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  refunded: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  void: 'bg-destructive/10 text-destructive',
}
const STATUS_LABEL: Record<CounterSaleRow['status'], string> = { paid: 'Paid', refunded: 'Refunded', void: 'Void' }

/**
 * Counter sales for the last few days. Cards on a phone, a table from md up — no
 * horizontal scroll at any width. Reprint opens the printable invoice; Correct is
 * a placeholder until the corrections ticket wires it.
 */
export function CounterSalesList({ sales, timeZone, currency, days }: { sales: CounterSaleRow[]; timeZone: string; currency: string; days: number }) {
  const when = (d: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d)
  const who = (s: CounterSaleRow) => s.customerName || s.customerPhone || 'Walk-in'

  return (
    <section className="mt-6" aria-labelledby="counter-sales-h">
      <h2 id="counter-sales-h" className="text-lg font-semibold">
        Counter sales <span className="text-sm font-normal text-muted-foreground">· last {days} days</span>
      </h2>
      {sales.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No counter sales yet.</p>
      ) : (
        <>
          {/* phone / small tablet: one card per sale */}
          <ul className="mt-3 space-y-2 md:hidden">
            {sales.map((s) => (
              <li key={s.orderId} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{who(s)}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {s.invoiceNumber} · {when(s.createdAt)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold">{formatMoney(s.total, currency)}</p>
                    <p className="text-sm text-muted-foreground">{s.method ? (METHOD_LABEL[s.method] ?? s.method) : '—'}</p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <StatusPill status={s.status} />
                  <Actions sale={s} />
                </div>
              </li>
            ))}
          </ul>

          {/* md and up: table */}
          <div className="mt-3 hidden overflow-hidden rounded-lg border border-border md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Bill</th>
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                  <th className="px-3 py-2 font-semibold">Method</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sales.map((s) => (
                  <tr key={s.orderId}>
                    <td className="px-3 py-2">
                      <p className="truncate font-medium">{s.invoiceNumber}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {s.orderNumber} · {when(s.createdAt)}
                      </p>
                    </td>
                    <td className="truncate px-3 py-2">{who(s)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatMoney(s.total, currency)}</td>
                    <td className="px-3 py-2">{s.method ? (METHOD_LABEL[s.method] ?? s.method) : '—'}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={s.status} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end">
                        <Actions sale={s} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function StatusPill({ status }: { status: CounterSaleRow['status'] }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>
}

function Actions({ sale }: { sale: CounterSaleRow }) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/invoices/${sale.invoiceId}`}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
      >
        <Printer size={14} /> Reprint
      </Link>
      {/* Wired in the corrections ticket (refund / void / re-bill). */}
      <button
        type="button"
        disabled
        title="Corrections are coming soon"
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium opacity-50"
      >
        <Wrench size={14} /> Correct
      </button>
    </div>
  )
}
