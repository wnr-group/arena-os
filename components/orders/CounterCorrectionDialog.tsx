'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Loader2, Minus, Plus, Trash2, X } from 'lucide-react'
import {
  editCounterOrderLine,
  getCounterSaleDetail,
  previewRebillCounterSale,
  rebillCounterSale,
  voidCounterSale,
} from '@/lib/actions/counter-orders'
import type { CounterSaleDetail } from '@/lib/orders/counter-data'
import type { CounterOrderResult, CounterPreview } from '@/lib/orders/counter'
import { SaleDone } from '@/components/orders/CounterOrderDialog'
import { formatMoney } from '@/lib/format'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'

type Method = 'cash' | 'upi' | 'card'
const METHODS: { value: Method; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
]
const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * Correct a counter sale (M41). The path is always the same one booking bills use:
 * refund + void the wrong bill (manager), edit the now-unbilled order, bill it
 * again. A billed sale cannot be edited in place. Every rule is enforced by the
 * server actions; this screen only shows the steps.
 */
export function CounterCorrectionDialog({
  orderId,
  currency,
  isManager,
  onClose,
}: {
  orderId: string
  currency: string
  isManager: boolean
  onClose: () => void
}) {
  const money = (n: number | string) => formatMoney(n, currency)
  const [detail, setDetail] = useState<CounterSaleDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [reason, setReason] = useState('')
  const [promo, setPromo] = useState<string | null>(null)
  const [method, setMethod] = useState<Method>('cash')
  const [tendered, setTendered] = useState('')
  const [preview, setPreview] = useState<CounterPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pricing, setPricing] = useState(false)
  const [sale, setSale] = useState<CounterOrderResult | null>(null)
  // One key per dialog: a double-tap or a retry after a dropped response is the same re-bill.
  const [idempotencyKey] = useState(() => newIdempotencyKey())

  const reload = useCallback(async () => {
    const r = await getCounterSaleDetail(orderId)
    if (r.error || !r.detail) setError(r.error ?? 'Could not load this sale.')
    else {
      setDetail(r.detail)
      setPromo((p) => p ?? r.detail!.promoCode ?? '')
    }
  }, [orderId])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  // Server-priced total for the re-bill, re-asked when the lines or the promo change.
  const lineKey = detail?.lines.map((l) => `${l.itemId}:${l.qty}`).join(',') ?? ''
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!detail || detail.state !== 'open' || detail.lines.length === 0 || promo === null) {
      setPricing(false)
      return
    }
    let live = true
    setPricing(true)
    const t = setTimeout(() => {
      previewRebillCounterSale({ orderId, promoCode: promo.trim() || undefined }).then((r) => {
        if (!live) return
        setPricing(false)
        if (r.error) setPreviewError(r.error)
        else setPreview(r.preview ?? null)
      })
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, detail?.state, lineKey, promo])

  function doVoid() {
    setError(null)
    start(async () => {
      const r = await voidCounterSale({ orderId, reason })
      if (r.error) setError(r.error)
      else {
        setReason('')
        await reload()
      }
    })
  }

  function changeQty(itemId: string, qty: number) {
    setError(null)
    start(async () => {
      const r = await editCounterOrderLine({ orderItemId: itemId, newQty: qty })
      if (r.error) setError(r.error)
      await reload()
    })
  }

  const total = preview?.total ?? null
  const tenderedNum = Number(tendered)
  const cashShort = method === 'cash' && total !== null && total > 0 && !(tendered.trim() !== '' && tenderedNum + 0.001 >= total)
  const change = method === 'cash' && total !== null && tendered.trim() !== '' && tenderedNum >= total ? tenderedNum - total : null

  function doRebill() {
    setError(null)
    start(async () => {
      const r = await rebillCounterSale({
        orderId,
        method,
        promoCode: (promo ?? '').trim() || undefined,
        cashTendered: method === 'cash' && tendered.trim() !== '' ? tenderedNum : undefined,
        idempotencyKey,
      })
      if (r.error || !r.sale) setError(r.error ?? 'Could not bill this order.')
      else setSale(r.sale)
    })
  }

  if (sale) return <SaleDone sale={sale} currency={currency} onDone={onClose} />

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Correct counter sale"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Correct sale</h2>
            <p className="truncate text-sm text-muted-foreground">
              {detail ? `${detail.orderNumber} · ${detail.customerName || detail.customerPhone || 'Walk-in'}` : 'Loading…'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full border border-border/60 p-1.5 text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {!detail ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {!error && <Loader2 size={14} className="animate-spin" />} {error ?? 'Loading…'}
            </p>
          ) : detail.state === 'cancelled' ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Every item was removed, so this order is cancelled. Nothing is left to bill — take a new counter order if needed.
            </p>
          ) : detail.state === 'billed' ? (
            <>
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">
                  Bill {detail.invoiceNumber} · {detail.total ? money(detail.total) : ''}
                </p>
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {detail.lines.map((l) => (
                    <li key={l.itemId}>
                      {l.qty} × {l.name}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-sm text-muted-foreground">
                A paid bill can’t be edited. To fix it: refund the payment and void the bill (below), then edit the items and bill again.
              </p>
              {isManager ? (
                <div>
                  <label className={labelCls} htmlFor="void-reason">Reason for refund &amp; void</label>
                  <textarea id="void-reason" className={`${field} min-h-20`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong quantity rung up" />
                  <button
                    type="button"
                    disabled={pending || !reason.trim()}
                    onClick={doVoid}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-destructive px-3.5 py-2.5 text-base font-medium text-destructive-foreground disabled:opacity-50"
                  >
                    {pending && <Loader2 size={16} className="animate-spin" />}
                    Refund {detail.total ? money(detail.total) : ''} &amp; void bill
                  </button>
                </div>
              ) : (
                <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">Only a manager or owner can refund and void a bill. Ask one to open this sale.</p>
              )}
            </>
          ) : (
            <>
              <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                Bill {detail.invoiceNumber ?? ''} was refunded and voided. Fix the items if needed, then bill this order again.
              </p>

              <ul className="space-y-2">
                {detail.lines.map((l) => (
                  <li key={l.itemId} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{l.name}</p>
                      <p className="text-xs text-muted-foreground">{money(l.unitPrice)} each</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <div className="inline-flex items-center rounded-md border border-border">
                        <button type="button" disabled={pending} onClick={() => changeQty(l.itemId, l.qty - 1)} className="px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label={`Decrease ${l.name}`}>
                          <Minus size={14} />
                        </button>
                        <span className="w-8 text-center text-sm font-medium">{l.qty}</span>
                        <button type="button" disabled={pending} onClick={() => changeQty(l.itemId, l.qty + 1)} className="px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label={`Increase ${l.name}`}>
                          <Plus size={14} />
                        </button>
                      </div>
                      <button type="button" disabled={pending} onClick={() => changeQty(l.itemId, 0)} className="rounded-md p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-50" aria-label={`Remove ${l.name}`}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div>
                <label className={labelCls} htmlFor="rebill-promo">Promo code</label>
                <input id="rebill-promo" className={`${field} uppercase`} maxLength={64} placeholder="Optional" value={promo ?? ''} onChange={(e) => setPromo(e.target.value)} />
                {previewError && <p className="mt-1 text-sm text-destructive">{previewError}</p>}
              </div>

              <div className="rounded-lg border border-border bg-card p-3 text-sm" aria-live="polite">
                {preview ? (
                  <div className="space-y-1 text-muted-foreground">
                    <div className="flex justify-between"><span>Subtotal</span><span>{money(preview.subtotal)}</span></div>
                    {preview.membershipDiscount > 0 && <div className="flex justify-between"><span>{preview.membershipPlanName ?? 'Membership'} discount</span><span>− {money(preview.membershipDiscount)}</span></div>}
                    {preview.promoDiscount > 0 && <div className="flex justify-between"><span>Promo {preview.promoCode}</span><span>− {money(preview.promoDiscount)}</span></div>}
                    <div className="flex justify-between"><span>GST</span><span>{money(preview.taxTotal)}</span></div>
                    <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold text-foreground"><span>Total</span><span>{money(preview.total)}</span></div>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    {pricing && <Loader2 size={14} className="animate-spin" />}
                    {pricing ? 'Calculating total…' : detail.lines.length === 0 ? 'No items left.' : 'Total unavailable.'}
                  </p>
                )}
              </div>

              <div>
                <p className={labelCls}>Payment</p>
                <div className="grid grid-cols-3 gap-2">
                  {METHODS.map((m) => (
                    <button key={m.value} type="button" onClick={() => setMethod(m.value)} aria-pressed={method === m.value} className={`rounded-lg border px-3 py-2 text-base font-medium transition ${method === m.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {method === 'cash' && total !== null && total > 0 && (
                <div>
                  <label className={labelCls} htmlFor="rebill-cash">Cash received</label>
                  <div className="flex gap-2">
                    <input id="rebill-cash" className={field} inputMode="decimal" placeholder="0.00" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                    <button type="button" className="shrink-0 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted" onClick={() => setTendered(total.toFixed(2))}>Exact</button>
                  </div>
                  {change !== null ? (
                    <p className="mt-1 text-sm font-semibold text-emerald-600 dark:text-emerald-400">Change due {money(change)}</p>
                  ) : tendered.trim() !== '' ? (
                    <p className="mt-1 text-sm text-destructive">Less than the {money(total)} bill.</p>
                  ) : null}
                </div>
              )}

              <button
                type="button"
                disabled={pending || pricing || preview === null || previewError !== null || cashShort}
                onClick={doRebill}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-base font-medium text-primary-foreground disabled:opacity-50"
              >
                {pending && <Loader2 size={16} className="animate-spin" />}
                {total !== null ? `Bill again · ${money(total)}` : 'Bill again'}
              </button>
            </>
          )}
          {error && detail && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}
