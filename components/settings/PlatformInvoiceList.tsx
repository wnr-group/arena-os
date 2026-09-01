'use client'

import Link from 'next/link'
import { Download, FileText, ReceiptText } from 'lucide-react'
import { money } from '@/lib/format'

/**
 * The business's Arena OS billing history (M16 #4, extended for the owner
 * billing portal in M16 #5).
 *
 * Purely presentational. Every figure shown is a stored snapshot handed down
 * from the server — nothing here recomputes a total or a tax — and nothing here
 * decides who may see it: `platform_invoices_owner_select` (migration 0052)
 * already limited the rows to invoices this owner's own tenant was billed.
 */

type Row = {
  id: string
  kind: 'subscription' | 'credit_note'
  invoiceNumber: string
  invoiceDate: string
  planName: string
  billingPeriodStart: string
  billingPeriodEnd: string
  billingPeriodType: string
  taxTotal: string
  total: string
  currency: string
  status: string
  /**
   * A stored document, when one exists. Null today: the project has no PDF
   * generator, and the invoice is instead a print-styled page reproducible
   * forever from its snapshot columns. The column is honoured here so a future
   * generator needs no UI change.
   */
  documentUrl: string | null
}

const d = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' })

export function PlatformInvoiceList({ invoices }: { invoices: Row[] }) {
  return (
    <section className="rounded-lg border">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <ReceiptText size={15} className="text-primary" />
        Invoice history
      </h2>

      {invoices.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No invoices yet. One is issued automatically each time a subscription payment is
          collected.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Plan &amp; period</th>
                <th className="px-4 py-2 text-right font-medium">GST</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                    {inv.invoiceNumber}
                    {inv.kind === 'credit_note' && (
                      <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        credit
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{d(inv.invoiceDate)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                    {inv.planName} · {inv.billingPeriodType}
                    <br />
                    <span className="text-xs">
                      {d(inv.billingPeriodStart)} – {d(inv.billingPeriodEnd)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {money(inv.currency, inv.taxTotal)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                    {money(inv.currency, inv.total)}
                  </td>
                  <td className="px-4 py-2 text-xs capitalize text-muted-foreground">
                    {inv.status}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <Link
                      href={`/settings/billing/invoices/${inv.id}`}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition hover:bg-muted"
                    >
                      <FileText size={12} /> View
                    </Link>
                    {inv.documentUrl && (
                      <a
                        href={inv.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition hover:bg-muted"
                      >
                        <Download size={12} /> PDF
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
