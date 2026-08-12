'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ReceiptText } from 'lucide-react'
import { createInvoiceForBooking } from '@/lib/actions/billing'
import { priceBill, type BillLine } from '@/lib/billing/pricing'
import { formatMoney, timeInZone, prettyDate } from '@/lib/format'
import { PaymentPanel, type SettlementView } from './PaymentPanel'

type BookingHeader = {
  id: string
  bookingNumber: string
  status: string
  billable: boolean
  branchName: string
  customerName: string | null
  customerPhone: string | null
  startsAt: string | null
  endsAt: string | null
  resourceNames: string[]
}
type ExistingInvoice = { id: string; invoiceNumber: string; status: string }

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const KIND_LABEL: Record<string, string> = {
  booking: 'Booking',
  food: 'Food',
  membership: 'Membership',
  adjustment: 'Adjustment',
}

export function BillScreen({
  booking,
  lines,
  existingInvoice,
  settlement,
  timeZone,
  currency,
}: {
  booking: BookingHeader
  lines: BillLine[]
  existingInvoice: ExistingInvoice | null
  /** Present once a bill exists — drives the payment panel. */
  settlement: SettlementView | null
  timeZone: string
  currency: string
}) {
  const router = useRouter()
  const [discountText, setDiscountText] = useState('')
  const [promoCode, setPromoCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const discount = Number(discountText)
  const discountValid = discountText === '' || (Number.isFinite(discount) && discount >= 0)

  // PREVIEW ONLY. The same priceBill the server uses, so what the cashier sees
  // matches what gets written — but the action recomputes everything from the
  // database and never receives a single figure from this component.
  const preview = useMemo(
    () => priceBill({ lines, discount: discountValid ? discount || 0 : 0 }),
    [lines, discount, discountValid],
  )

  const bookingItems = preview.items.filter((i) => i.kind === 'booking')
  const foodItems = preview.items.filter((i) => i.kind === 'food')
  const gst = preview.taxBreakup.reduce(
    (acc, g) => ({ cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst }),
    { cgst: 0, sgst: 0 },
  )

  const blocked = Boolean(existingInvoice) || !booking.billable || lines.length === 0
  const money = (n: number) => formatMoney(n, currency)

  function generate() {
    if (blocked || pending) return
    if (!discountValid) {
      setError('Enter a discount of zero or more.')
      return
    }
    setError(null)
    start(async () => {
      const r = await createInvoiceForBooking({
        bookingId: booking.id,
        // Only the discount travels. No prices, no totals, no tax.
        discount: discountText === '' ? undefined : discount,
        promoCode: promoCode.trim() || undefined,
      })
      if (r.error || !r.invoiceId) {
        setError(r.error ?? 'Could not raise the bill.')
        return
      }
      // Stay on the POS screen: refreshing swaps the bill form for the payment
      // panel, which is where the cashier settles the invoice. (The receipt
      // route /invoices/[id] is still to be built — see AROS-26 scope.)
      router.refresh()
    })
  }

  return (
    <div className="px-6 py-6">
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={15} /> Bookings
      </Link>

      {/* ── booking header ── */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bill · {booking.bookingNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {booking.customerName || 'Walk-in'}
            {booking.customerPhone && ` · ${booking.customerPhone}`}
            {' · '}
            {booking.branchName}
          </p>
          <p className="text-sm text-muted-foreground">
            {booking.startsAt && (
              <>
                {prettyDate(booking.startsAt.slice(0, 10), timeZone)} ·{' '}
                {timeInZone(booking.startsAt, timeZone)}
                {booking.endsAt && `–${timeInZone(booking.endsAt, timeZone)}`}
              </>
            )}
            {booking.resourceNames.length > 0 && ` · ${booking.resourceNames.join(', ')}`}
          </p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs font-medium capitalize">
          {booking.status.replace('_', ' ')}
        </span>
      </div>

      {/* ── blocking states ── */}
      {existingInvoice && (
        <Notice tone="info">
          Billed as <span className="font-medium">{existingInvoice.invoiceNumber}</span>. The
          pricing is frozen — settle the balance in the payment panel.{' '}
          <Link href={`/invoices/${existingInvoice.id}`} className="font-medium underline">
            View GST invoice
          </Link>
        </Notice>
      )}
      {!existingInvoice && !booking.billable && (
        <Notice tone="warn">This booking cannot be billed in its current status.</Notice>
      )}
      {!existingInvoice && booking.billable && lines.length === 0 && (
        <Notice tone="warn">This booking has nothing to bill.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* ── lines ── */}
        <div className="space-y-6">
          <LineTable title="Booking charges" items={bookingItems} money={money} />
          {foodItems.length > 0 && (
            <LineTable title="Food & beverage" items={foodItems} money={money} />
          )}
        </div>

        {/* ── settle: once a bill exists the pricing is frozen, so the discount
             form gives way to the payment panel ── */}
        {settlement ? (
          // Keyed on what has been taken so the amount field re-defaults to the
          // new balance after each tender.
          <PaymentPanel
            key={settlement.paid}
            settlement={settlement}
            timeZone={timeZone}
            currency={currency}
          />
        ) : (
        <aside className="space-y-4 rounded-lg border p-4">
          <div>
            <label htmlFor="discount" className="text-sm font-medium">
              Discount
            </label>
            <input
              id="discount"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={discountText}
              onChange={(e) => setDiscountText(e.target.value)}
              disabled={blocked || pending}
              placeholder="0.00"
              className={`mt-1 ${input}`}
            />
            {!discountValid && (
              <p className="mt-1 text-xs text-destructive">Enter zero or more.</p>
            )}
          </div>

          <div>
            <label htmlFor="promo" className="text-sm font-medium">
              Promo code
            </label>
            <input
              id="promo"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              disabled={blocked || pending}
              placeholder="e.g. WELCOME10"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={`mt-1 ${input} disabled:cursor-not-allowed disabled:opacity-60`}
            />
            {/* The server resolves the code, decides the discount and records
                the use. An invalid code fails the whole bill rather than
                quietly charging full price. The preview above cannot know the
                promo's value, so it shows the typed discount only. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {promoCode.trim()
                ? 'The promo discount is applied by the server when the bill is raised.'
                : 'Overrides the discount above when applied.'}
            </p>
          </div>

          <dl className="space-y-1.5 border-t pt-4 text-sm">
            <Total k="Subtotal" v={money(preview.subtotal)} />
            <Total k="Discount" v={`− ${money(preview.discount)}`} />
            <Total k="Taxable value" v={money(preview.taxableValue)} muted />
            <Total k="CGST" v={money(gst.cgst)} muted />
            <Total k="SGST" v={money(gst.sgst)} muted />
            <Total k="GST total" v={money(preview.taxTotal)} />
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <dt>Grand total</dt>
              <dd>{money(preview.total)}</dd>
            </div>
          </dl>

          <button
            onClick={generate}
            disabled={blocked || pending || !discountValid}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <ReceiptText size={16} />
            {pending ? 'Generating…' : 'Generate bill'}
          </button>
          <p className="text-center text-xs text-muted-foreground">
            Totals are recalculated on the server when the bill is raised.
          </p>
        </aside>
        )}
      </div>
    </div>
  )
}

function LineTable({
  title,
  items,
  money,
}: {
  title: string
  items: { description: string; kind: string; qty: number; unitPrice: number; taxPercent: number; lineTotal: number }[]
  money: (n: number) => string
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing to bill here.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Unit</th>
                <th className="py-2 pr-3 text-right font-medium">Tax</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, n) => (
                <tr key={`${i.description}-${n}`} className="border-b last:border-0">
                  <td className="py-2 pr-3">{i.description}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{KIND_LABEL[i.kind] ?? i.kind}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{i.qty}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(i.unitPrice)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {i.taxPercent}%
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">{money(i.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Total({ k, v, muted = false }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${muted ? 'text-muted-foreground' : ''}`}>
      <dt>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : tone === 'info'
        ? 'border-border bg-muted/50 text-muted-foreground'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
  return <p className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</p>
}
