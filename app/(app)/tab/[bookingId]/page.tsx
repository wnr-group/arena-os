import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ReceiptText } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { getRunningTab } from '@/lib/billing/data'
import { PrintTabButton } from '@/components/pos/PrintTabButton'
import { formatMoney, timeInZone } from '@/lib/format'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KIND_LABEL: Record<string, string> = {
  booking: 'Booking',
  food: 'Food',
  membership: 'Membership',
  adjustment: 'Adjustment',
  wallet_topup: 'Wallet top-up',
}

export default async function RunningTabPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const { bookingId } = await params
  if (!UUID.test(bookingId)) notFound()

  // Tenant-scoped: another workspace's booking id returns null under RLS,
  // which is indistinguishable from "no such booking" — the URL leaks nothing.
  const tab = await getRunningTab(ctx, bookingId)
  if (!tab) notFound()

  const { booking, pricing, existingInvoice } = tab
  const money = (v: string | number) => formatMoney(v, ctx.tenant.currency)
  const now = new Date()

  return (
    <div className="px-4 py-6 sm:px-6">
      {/* ── screen-only action bar ── */}
      <div className="no-print mx-auto flex max-w-2xl items-center justify-between gap-3">
        <Link
          href="/floor"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/pos/${booking.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <ReceiptText size={15} /> Go to bill
          </Link>
          <PrintTabButton />
        </div>
      </div>

      {/* ── the running tab ── */}
      <article className="print-sheet mx-auto mt-4 max-w-2xl rounded-lg border bg-card p-6 shadow-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold uppercase tracking-wide">{ctx.tenant.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {booking.tableName ?? 'Booking'} · {booking.bookingNumber}
            </p>
            {booking.coverCount && (
              <p className="text-sm text-muted-foreground">{booking.coverCount} guests</p>
            )}
            {(booking.customerName || booking.customerPhone) && (
              <p className="text-sm text-muted-foreground">
                {[booking.customerName, booking.customerPhone].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-base font-bold uppercase tracking-widest">Running Tab</p>
            <span className="mt-2 inline-block rounded border border-amber-500 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-600">
              Estimate
            </span>
            <p className="mt-2 text-xs text-muted-foreground">
              As of {timeInZone(now, ctx.tenant.timezone)}
            </p>
          </div>
        </header>

        {existingInvoice ? (
          <section className="print-keep py-8 text-center">
            <p className="text-sm text-muted-foreground">
              This table has already been billed as invoice{' '}
              <span className="font-medium text-foreground">{existingInvoice.invoiceNumber}</span>.
            </p>
            <Link
              href={`/invoices/${existingInvoice.id}`}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              View the invoice
            </Link>
          </section>
        ) : (
          <>
            {/* items */}
            <section className="py-5">
              <div className="print-flat overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold">Description</th>
                      <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                      <th className="py-2 pr-3 text-right font-semibold">Unit Price</th>
                      <th className="py-2 text-right font-semibold">Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricing.items.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-4 text-center text-muted-foreground">
                          Nothing on the tab yet.
                        </td>
                      </tr>
                    ) : (
                      pricing.items.map((i, idx) => (
                        <tr key={`${i.sourceId ?? idx}`} className="border-b last:border-0 align-top">
                          <td className="py-2 pr-3">
                            {i.description}
                            <span className="block text-xs text-muted-foreground">
                              {KIND_LABEL[i.kind] ?? i.kind}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{i.qty}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{money(i.unitPrice)}</td>
                          <td className="py-2 text-right font-medium tabular-nums">{money(i.lineTotal)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* totals */}
            <section className="print-keep flex justify-end border-t pt-5">
              <dl className="w-full space-y-1.5 text-sm sm:w-72">
                <Row k="Subtotal" v={money(pricing.subtotal)} />
                {pricing.taxBreakup.map((g) => (
                  <div key={g.percent} className="pt-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      GST {g.percent}%
                    </p>
                    <Row k="CGST" v={money(g.cgst)} indent />
                    <Row k="SGST" v={money(g.sgst)} indent />
                  </div>
                ))}
                <div className="flex justify-between gap-4 border-t pt-2 text-base font-bold">
                  <dt>Estimated Total</dt>
                  <dd className="tabular-nums">{money(pricing.total)}</dd>
                </div>
              </dl>
            </section>
          </>
        )}

        <footer className="mt-6 border-t pt-4 text-center text-xs text-muted-foreground">
          Estimate only — not a tax invoice. The final bill is generated at checkout.
        </footer>
      </article>
    </div>
  )
}

function Row({ k, v, indent = false }: { k: string; v: string; indent?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${indent ? 'pl-3 text-muted-foreground' : ''}`}>
      <dt>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}
