import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getActiveContext } from '@/lib/tenant/context'
import { isOwner } from '@/lib/auth/roles'
import { getPlatformInvoice } from '@/lib/platform/billing/data'

/**
 * One Arena OS GST invoice, as a printable document (M16 #4).
 *
 * ── EVERY FIGURE ON THIS PAGE IS A STORED SNAPSHOT ──────────────────────────
 *
 * The rule lib/billing/receipt.ts states for POS receipts, restated because it
 * is the reason this page exists: nothing here recomputes money, re-derives GST
 * from a rate, or looks up a live plan price, a live business profile or the
 * platform's current letterhead. Every value — both parties' names, GSTINs and
 * addresses, the place of supply, the plan, the rate, the CGST/SGST/IGST split
 * — is read straight off the row that was written when the payment cleared.
 *
 * So an invoice from two years ago renders today exactly as it did then, even
 * though the business has since moved office and Arena OS has since reprised
 * its plans. That is the whole point of the snapshot columns in migration 0072.
 *
 * ── Why this is the "PDF" ───────────────────────────────────────────────────
 *
 * This project has no PDF generator and deliberately does not gain one here:
 * the existing invoice receipt (app/(app)/invoices/[id]) is a print-styled page
 * the browser turns into a PDF, and following that pattern costs one CSS class
 * instead of a rendering dependency. `platform_invoices.document_url` exists for
 * a stored artefact if one is ever generated, and is null until then.
 *
 * ── Access ──────────────────────────────────────────────────────────────────
 *
 * getPlatformInvoice() runs through withUser() on the RLS-scoped connection and
 * `platform_invoices_owner_select` admits only rows this owner's own tenant was
 * billed. An unknown id and a hidden one both return null and therefore the same
 * 404, so this page cannot be used to probe which invoice ids exist.
 */
export default async function PlatformInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only; RLS is the boundary.
  if (!isOwner(ctx.role)) redirect('/dashboard')

  const { id } = await params
  const invoice = await getPlatformInvoice(ctx, id)
  if (!invoice) notFound()

  const isCredit = invoice.kind === 'credit_note'
  const fmt = (v: string) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: invoice.currency,
    }).format(Number(v))
  const day = (v: Date | string) =>
    new Date(v).toLocaleDateString('en-IN', { dateStyle: 'medium' })

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* `no-print` is the class AppShell already uses to strip chrome for the
          POS receipt; reusing it keeps one print convention in the app. */}
      <div className="no-print mb-6 flex items-center justify-between">
        <Link
          href="/settings/billing"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Billing
        </Link>
      </div>

      <article className="rounded-lg border p-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div>
            <h1 className="text-lg font-semibold">
              {isCredit ? 'Credit Note' : 'Tax Invoice'}
            </h1>
            <p className="mt-1 font-mono text-sm">{invoice.invoiceNumber}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Dated {day(invoice.invoiceDate)}
            </p>
          </div>
          <div className="text-right text-sm">
            <p className="font-medium">{invoice.sellerLegalName}</p>
            {invoice.sellerAddress && (
              <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
                {invoice.sellerAddress}
              </p>
            )}
            {invoice.sellerGstin && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                GSTIN {invoice.sellerGstin}
              </p>
            )}
          </div>
        </header>

        <section className="grid gap-4 border-b py-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Billed to</p>
            <p className="mt-1 text-sm font-medium">{invoice.buyerLegalName}</p>
            {invoice.buyerAddress && (
              <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
                {invoice.buyerAddress}
              </p>
            )}
            {/* No fallback: a GSTIN is either on record or it is not, and
                inventing one on a tax document would be worse than a gap. */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              GSTIN {invoice.buyerGstin ?? '—'}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-medium text-muted-foreground">Place of supply</p>
            <p className="mt-1 text-sm">{invoice.placeOfSupply ?? '—'}</p>
            <p className="mt-2 text-xs font-medium text-muted-foreground">Billing period</p>
            <p className="mt-1 text-sm">
              {day(invoice.billingPeriodStart)} – {day(invoice.billingPeriodEnd)}
            </p>
          </div>
        </section>

        <table className="w-full py-4 text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-2">
                {invoice.planName} · {invoice.billingPeriodType} subscription
                {isCredit && ' (credit)'}
              </td>
              <td className="py-2 text-right tabular-nums">{fmt(invoice.subtotal)}</td>
            </tr>
            {Number(invoice.adjustment) > 0 && (
              <tr className="border-b">
                <td className="py-2 text-muted-foreground">Proration credit applied</td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  −{fmt(invoice.adjustment)}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <section className="ml-auto max-w-xs space-y-1 border-t pt-4 text-sm">
          <Row k="Taxable value" v={fmt(invoice.taxableValue)} />
          {/* CGST+SGST or IGST — never both. Which one appears is decided at
              issue time from the two parties' state codes and stored, so it
              cannot change if either party later moves. */}
          {Number(invoice.igst) > 0 ? (
            <Row k={`IGST @ ${Number(invoice.gstRate)}%`} v={fmt(invoice.igst)} />
          ) : (
            <>
              <Row k={`CGST @ ${Number(invoice.gstRate) / 2}%`} v={fmt(invoice.cgst)} />
              <Row k={`SGST @ ${Number(invoice.gstRate) / 2}%`} v={fmt(invoice.sgst)} />
            </>
          )}
          <div className="flex justify-between border-t pt-2 font-semibold">
            <span>{isCredit ? 'Credit total' : 'Total'}</span>
            <span className="tabular-nums">{fmt(invoice.total)}</span>
          </div>
        </section>

        <footer className="mt-6 space-y-1 border-t pt-4 text-xs text-muted-foreground">
          <p>
            Status: <span className="capitalize">{invoice.status}</span>
            {invoice.gatewayPaymentId && <> · Payment reference {invoice.gatewayPaymentId}</>}
          </p>
          {invoice.notes && <p>{invoice.notes}</p>}
          <p>
            Arena OS subscription fee. This is separate from any payments your venue collects
            from its own customers.
          </p>
        </footer>
      </article>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  )
}
