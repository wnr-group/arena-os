'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Loader2, Printer, X } from 'lucide-react'
import { TakeOrderDialog, type CategoryOption, type MenuItemOption, type PlacedLine } from '@/components/orders/TakeOrderDialog'
import { createCounterOrder, lookupCounterCustomer, previewCounterOrder } from '@/lib/actions/counter-orders'
import type { CounterOrderResult, CounterPreview } from '@/lib/orders/counter'
import type { HappyHourRule } from '@/lib/happy-hours/apply'
import { isValidPhone } from '@/lib/customers/phone'
import { formatMoney } from '@/lib/format'

type Method = 'cash' | 'upi' | 'card'
const METHODS: { value: Method; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
]

const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const label = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * Counter order (M41): a food-only sale at the counter — pick items, take the
 * customer's phone, pay, done. Built on TakeOrderDialog (menu, modifiers, 86'd
 * items) with a checkout panel in its cart. The total shown is the SERVER's
 * (previewCounterOrder runs the real pricing and rolls back); nothing here is
 * trusted — createCounterOrder re-prices, re-checks the promo and the plan.
 */
export function CounterOrderDialog({
  branchId,
  currency,
  categories,
  menuItems,
  happyHours,
  timeZone,
  canToggle86,
  onClose,
}: {
  branchId: string
  currency: string
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
  timeZone: string
  canToggle86: boolean
  onClose: () => void
}) {
  const [phone, setPhone] = useState('')
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [name, setName] = useState('')
  const [nameFromRecord, setNameFromRecord] = useState(false)
  const [plan, setPlan] = useState<string | null>(null)
  const [promo, setPromo] = useState('')
  const [method, setMethod] = useState<Method>('cash')
  const [tendered, setTendered] = useState('')
  const [lines, setLines] = useState<PlacedLine[]>([])
  const [preview, setPreview] = useState<CounterPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pricing, setPricing] = useState(false)
  const [sale, setSale] = useState<CounterOrderResult | null>(null)
  const saleRef = useRef<CounterOrderResult | null>(null)

  const phoneOk = isValidPhone(phone)

  // Existing customer → fill the name, show the membership. Display only.
  useEffect(() => {
    setPlan(null)
    if (!phoneOk) {
      if (nameFromRecord) {
        setName('')
        setNameFromRecord(false)
      }
      return
    }
    let live = true
    lookupCounterCustomer(phone).then((r) => {
      if (!live || r.error) return
      if (r.found && r.name) {
        setName(r.name)
        setNameFromRecord(true)
      } else if (nameFromRecord) {
        setName('')
        setNameFromRecord(false)
      }
      setPlan(r.found ? (r.membershipPlan ?? null) : null)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, phoneOk])

  // Server-computed total, re-asked (debounced) whenever the cart, phone or promo changes.
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!phoneOk || lines.length === 0) {
      setPricing(false)
      return
    }
    let live = true
    setPricing(true)
    const t = setTimeout(() => {
      previewCounterOrder({ branchId, customerPhone: phone, promoCode: promo.trim() || undefined, items: lines }).then((r) => {
        if (!live) return
        setPricing(false)
        if (r.error) setPreviewError(r.error)
        else setPreview(r.preview ?? null)
      })
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [branchId, phone, phoneOk, promo, lines])

  const total = preview?.total ?? null
  const tenderedNum = Number(tendered)
  const cashShort = method === 'cash' && total !== null && total > 0 && !(tendered.trim() !== '' && tenderedNum + 0.001 >= total)
  const change = method === 'cash' && total !== null && tendered.trim() !== '' && tenderedNum >= total ? tenderedNum - total : null

  const phoneMessage = !phone.trim() ? 'Enter the customer’s phone number.' : !phoneOk ? 'Enter a valid 10-digit phone number.' : null

  const submitDisabled = !phoneOk || pricing || preview === null || previewError !== null || cashShort

  const money = (n: number | string) => formatMoney(n, currency)

  const slot = (
    <div className="mb-3 space-y-3">
      <div>
        <label className={label} htmlFor="counter-phone">
          Customer phone <span className="text-destructive">*</span>
        </label>
        <input
          id="counter-phone"
          className={field}
          inputMode="tel"
          autoComplete="off"
          placeholder="10-digit mobile number"
          maxLength={16}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => setPhoneTouched(true)}
          aria-invalid={phoneTouched && phoneMessage !== null}
        />
        {phoneTouched && phoneMessage && <p className="mt-1 text-sm text-destructive">{phoneMessage}</p>}
      </div>
      <div>
        <label className={label} htmlFor="counter-name">
          Name {nameFromRecord && <span className="normal-case text-muted-foreground">· from customer record</span>}
        </label>
        <input id="counter-name" className={field} placeholder="Optional" maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setNameFromRecord(false) }} />
        {plan && (
          <p className="mt-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{plan} member</p>
        )}
      </div>
      <div>
        <label className={label} htmlFor="counter-promo">Promo code</label>
        <input id="counter-promo" className={`${field} uppercase`} placeholder="Optional" maxLength={64} value={promo} onChange={(e) => setPromo(e.target.value)} />
        {previewError && <p className="mt-1 text-sm text-destructive">{previewError}</p>}
      </div>

      <div className="rounded-lg border border-border bg-card p-3 text-sm" aria-live="polite">
        {preview ? (
          <div className="space-y-1">
            <Row k="Subtotal" v={money(preview.subtotal)} />
            {preview.membershipDiscount > 0 && <Row k={`${preview.membershipPlanName ?? 'Membership'} discount`} v={`− ${money(preview.membershipDiscount)}`} />}
            {preview.promoDiscount > 0 && <Row k={`Promo ${preview.promoCode ?? ''}`} v={`− ${money(preview.promoDiscount)}`} />}
            <Row k="GST" v={money(preview.taxTotal)} />
            <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
              <span>Total</span>
              <span>{money(preview.total)}</span>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground">
            {pricing && <Loader2 size={14} className="animate-spin" />}
            {pricing ? 'Calculating total…' : !phoneOk ? 'Enter a phone number and add items to see the total.' : lines.length === 0 ? 'Add items to see the total.' : 'Total unavailable.'}
          </p>
        )}
      </div>

      <div>
        <p className={label}>Payment</p>
        <div className="grid grid-cols-3 gap-2">
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMethod(m.value)}
              aria-pressed={method === m.value}
              className={`rounded-lg border px-3 py-2 text-base font-medium transition ${
                method === m.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {method === 'cash' && total !== null && total > 0 && (
        <div>
          <label className={label} htmlFor="counter-tendered">Cash received</label>
          <div className="flex gap-2">
            <input id="counter-tendered" className={field} inputMode="decimal" placeholder="0.00" value={tendered} onChange={(e) => setTendered(e.target.value)} />
            <button type="button" className="shrink-0 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted" onClick={() => setTendered(total.toFixed(2))}>
              Exact
            </button>
          </div>
          {change !== null ? (
            <p className="mt-1 text-sm font-semibold text-emerald-600 dark:text-emerald-400">Change due {money(change)}</p>
          ) : tendered.trim() !== '' ? (
            <p className="mt-1 text-sm text-destructive">Less than the {money(total)} bill.</p>
          ) : null}
        </div>
      )}
    </div>
  )

  if (sale) {
    return <SaleDone sale={sale} currency={currency} onDone={onClose} />
  }

  return (
    <TakeOrderDialog
      branchId={branchId}
      currency={currency}
      categories={categories}
      menuItems={menuItems}
      happyHours={happyHours}
      timeZone={timeZone}
      canToggle86={canToggle86}
      title="Counter order"
      headerNote="Food & drinks only — paid in full now, sent to the kitchen."
      checkoutSlot={slot}
      hideTotals
      submitLabel={total !== null ? `Pay ${money(total)}` : 'Pay'}
      pendingLabel="Taking payment…"
      submitDisabled={submitDisabled}
      onCartChange={setLines}
      // The dialog hands us ONE idempotency key for this attempt (stable while it
      // stays open), so a double-tap or a retry after a dropped response is the
      // same sale on the server, never a second one.
      placeOrder={async (items, idempotencyKey) => {
        setPhoneTouched(true)
        const r = await createCounterOrder({
          branchId,
          customerPhone: phone,
          customerName: name.trim() || undefined,
          method,
          cashTendered: method === 'cash' && tendered.trim() !== '' ? tenderedNum : undefined,
          promoCode: promo.trim() || undefined,
          idempotencyKey,
          items,
        })
        if (r.error || !r.sale) return { error: r.error ?? 'Could not complete the sale.' }
        saleRef.current = r.sale
        return { orderNumber: r.sale.orderNumber }
      }}
      onClose={onClose}
      onCreated={() => setSale(saleRef.current)}
    />
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-muted-foreground">
      <span className="min-w-0 truncate">{k}</span>
      <span className="shrink-0">{v}</span>
    </div>
  )
}

/** The bill after a successful sale — summary here, the printable GST invoice one tap away. */
export function SaleDone({ sale, currency, onDone }: { sale: CounterOrderResult; currency: string; onDone: () => void }) {
  const money = (n: number | string) => formatMoney(n, currency)
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Sale complete">
      <div className="max-h-full w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="text-emerald-600" size={22} />
            <h2 className="text-lg font-semibold">Paid · {sale.invoiceNumber}</h2>
          </div>
          <button type="button" onClick={onDone} aria-label="Close" className="rounded-full border border-border/60 p-1.5 text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Order {sale.orderNumber} · kitchen ticket {sale.kotNumber || '—'} sent
        </p>

        <div className="mt-4 space-y-1.5 text-sm">
          <Row k="Subtotal" v={money(sale.subtotal)} />
          {sale.membershipDiscount > 0 && <Row k={`${sale.membershipPlanName ?? 'Membership'} discount`} v={`− ${money(sale.membershipDiscount)}`} />}
          {sale.promoDiscount > 0 && <Row k={`Promo ${sale.promoCode ?? ''}`} v={`− ${money(sale.promoDiscount)}`} />}
          <Row k="GST" v={money(sale.taxTotal)} />
          <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold">
            <span>Total</span>
            <span>{money(sale.total)}</span>
          </div>
          <Row k="Paid by" v={sale.method.toUpperCase()} />
          {sale.cashTendered !== null && <Row k="Cash received" v={money(sale.cashTendered)} />}
          {sale.changeDue !== null && sale.changeDue > 0 && (
            <div className="flex justify-between text-base font-semibold text-emerald-600 dark:text-emerald-400">
              <span>Change due</span>
              <span>{money(sale.changeDue)}</span>
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Link
            href={`/invoices/${sale.invoiceId}`}
            target="_blank"
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-base font-medium text-primary-foreground hover:opacity-90"
          >
            <Printer size={16} /> View &amp; print bill
          </Link>
          <button type="button" onClick={onDone} className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium hover:bg-muted">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
