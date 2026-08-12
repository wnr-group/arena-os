import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getInvoice } from '@/lib/billing/data'
import { round2 } from '@/lib/billing/pricing'
import { PrintButton } from '@/components/invoices/PrintButton'
import { InvoiceActions } from '@/components/invoices/InvoiceActions'
import { formatMoney, prettyDate } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KIND_LABEL: Record<string, string> = {
  booking: 'Booking',
  food: 'Food',
  membership: 'Membership',
  adjustment: 'Adjustment',
}
const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  online: 'Online',
  wallet: 'Wallet',
}

/** Trailing zeros trimmed so 2.00 h reads "2" but 1.50 h still reads "1.5". */
function formatQty(qty: string): string {
  const n = Number(qty)
  return Number.isFinite(n) ? String(n) : qty
}

export default async function InvoiceReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const { id } = await params
  if (!UUID.test(id)) notFound()

  // Tenant-scoped: another workspace's invoice id returns null under RLS, which
  // is indistinguishable from "no such invoice" — the URL leaks nothing.
  const receipt = await getInvoice(ctx, id)
  if (!receipt) notFound()

  const { invoice, items, payments, business, customer } = receipt
  const tz = ctx.tenant.timezone
  const money = (v: string | number) => formatMoney(v, ctx.tenant.currency)
  const invoiceDate = invoice.issuedAt ?? invoice.createdAt
  // Everything that actually reached the till, refunded or not — a receipt that
  // hid a refunded tender would misrepresent what happened.
  const settledPayments = payments.filter((p) => p.status === 'captured' || p.status === 'refunded')
  // Captured money not yet refunded. Non-zero blocks a void; mirrors the
  // server's rule in lib/billing/refunds.ts (which re-checks it under a lock).
  const outstandingCaptured = payments
    .filter((p) => p.status === 'captured')
    .reduce((acc, p) => round2(acc + Number(p.refundable)), 0)
    .toFixed(2)
  const hasRefunds = Number(receipt.refundsTotal) > 0

  return (
    <div className="px-4 py-6 sm:px-6">
      {/* ── screen-only action bar ── */}
      <div className="no-print mx-auto flex max-w-3xl items-center justify-between gap-3">
        <Link
          href={invoice.bookingId ? `/pos/${invoice.bookingId}` : '/bookings'}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {/* Rendered for managers only — but that is presentation. Both actions
              call requireManager() server-side, and refunds carry a manager-only
              RLS policy on top of that. */}
          {isManager(ctx.role) && (
            <InvoiceActions
              invoiceId={invoice.id}
              invoiceStatus={invoice.status}
              payments={settledPayments.map((p) => ({
                id: p.id,
                method: p.method,
                amount: p.amount,
                status: p.status,
                refunded: p.refunded,
                refundable: p.refundable,
              }))}
              outstandingCaptured={outstandingCaptured}
              currency={ctx.tenant.currency}
            />
          )}
          <PrintButton />
        </div>
      </div>

      {/* ── the receipt ── */}
      <article className="print-sheet mx-auto mt-4 max-w-3xl rounded-lg border bg-card p-6 shadow-sm sm:p-8">
        {/* header / letterhead */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div className="min-w-0">
            {/* Logo storage is not implemented (see AROS-31 note below). */}
            <h1 className="text-lg font-semibold uppercase tracking-wide">{business.legalName}</h1>
            <p className="mt-1 text-sm">
              <span className="text-muted-foreground">GSTIN: </span>
              {business.gstin ?? (
                <span className="font-medium text-destructive">Not configured</span>
              )}
            </p>
            {business.address && (
              <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">
                {business.address}
              </p>
            )}
            {business.phone && (
              <p className="text-sm text-muted-foreground">{business.phone}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-base font-bold uppercase tracking-widest">Tax Invoice</p>
            {receipt.fullyPaid ? (
              <span className="mt-2 inline-block rounded border border-emerald-600 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-emerald-700">
                Paid
              </span>
            ) : (
              <span className="mt-2 inline-block rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider capitalize">
                {invoice.status}
              </span>
            )}
          </div>
        </header>

        {/* invoice meta + bill-to */}
        <section className="grid gap-5 border-b py-5 sm:grid-cols-2">
          <dl className="space-y-1 text-sm">
            <Meta k="Invoice No" v={invoice.invoiceNumber} strong />
            <Meta k="Invoice Date" v={prettyDate(todayInZone(tz, invoiceDate), tz)} />
            <Meta k="Place of Supply" v={invoice.placeOfSupply ?? '—'} />
          </dl>
          <div className="text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Bill To
            </p>
            <p className="mt-1 font-medium">{customer?.name?.trim() || 'Walk-in Customer'}</p>
            {customer?.phone && <p className="text-muted-foreground">{customer.phone}</p>}
          </div>
        </section>

        {/* items */}
        <section className="py-5">
          <div className="print-flat overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-semibold">Description</th>
                  <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                  <th className="py-2 pr-3 text-right font-semibold">Unit Price</th>
                  <th className="py-2 pr-3 text-right font-semibold">Tax %</th>
                  <th className="py-2 text-right font-semibold">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-muted-foreground">
                      No line items on this invoice.
                    </td>
                  </tr>
                ) : (
                  items.map((i) => (
                    <tr key={i.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-3">
                        {i.description}
                        <span className="block text-xs text-muted-foreground">
                          {KIND_LABEL[i.kind] ?? i.kind}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatQty(i.qty)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(i.unitPrice)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{Number(i.taxRate)}%</td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {money(i.lineTotal)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* totals — every figure below is read from the stored invoice */}
        <section className="print-keep flex justify-end border-t pt-5">
          <dl className="w-full space-y-1.5 text-sm sm:w-72">
            <Row k="Subtotal" v={money(invoice.subtotal)} />
            {Number(invoice.discount) > 0 && (
              <Row k="Discount" v={`− ${money(invoice.discount)}`} />
            )}

            {invoice.taxBreakup.map((g) => (
              <div key={g.rate} className="pt-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  GST {g.rate}%
                </p>
                <Row k="CGST" v={money(g.cgst)} indent />
                <Row k="SGST" v={money(g.sgst)} indent />
                {g.igst && <Row k="IGST" v={money(g.igst)} indent />}
              </div>
            ))}

            {invoice.taxBreakup.length > 1 && (
              <>
                <Row k="Total CGST" v={money(receipt.cgstTotal)} />
                <Row k="Total SGST" v={money(receipt.sgstTotal)} />
              </>
            )}

            <div className="flex justify-between gap-4 border-t pt-2 text-base font-bold">
              <dt>Grand Total</dt>
              <dd className="tabular-nums">{money(invoice.total)}</dd>
            </div>
          </dl>
        </section>

        {/* payments */}
        <section className="print-keep mt-6 border-t pt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Payments
          </p>
          {settledPayments.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No payments recorded yet.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {settledPayments.map((p) => (
                <li key={p.id} className="flex justify-between gap-4">
                  <span>
                    {METHOD_LABEL[p.method] ?? p.method}
                    {Number(p.refunded) > 0 && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {p.status === 'refunded'
                          ? 'refunded in full'
                          : `${money(p.refunded)} refunded`}
                      </span>
                    )}
                  </span>
                  <span
                    className={`tabular-nums ${p.status === 'refunded' ? 'text-muted-foreground line-through' : ''}`}
                  >
                    {money(p.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 space-y-1 border-t pt-3 text-sm">
            <Row k="Total Paid" v={money(receipt.paidTotal)} />
            {hasRefunds && <Row k="Refunded" v={`− ${money(receipt.refundsTotal)}`} />}
            {receipt.fullyPaid ? (
              <div className="flex justify-between gap-4 font-bold text-emerald-700">
                <dt>Balance</dt>
                <dd className="tabular-nums">{money('0.00')}</dd>
              </div>
            ) : (
              <div className="flex justify-between gap-4 font-bold">
                <dt>Balance Due</dt>
                <dd className="tabular-nums">{money(receipt.balanceDue)}</dd>
              </div>
            )}
          </div>
        </section>

        <footer className="mt-6 border-t pt-4 text-center text-xs text-muted-foreground">
          This is a computer-generated tax invoice.
        </footer>
      </article>
    </div>
  )
}

function Meta({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-muted-foreground">{k}</dt>
      <dd className={strong ? 'font-semibold' : ''}>{v}</dd>
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
