'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { BadgeCheck, Wallet } from 'lucide-react'
import { recordPayment } from '@/lib/actions/payments'
import { round2 } from '@/lib/billing/pricing'
import { formatMoney, timeInZone } from '@/lib/format'

/**
 * Split payments against an issued invoice.
 *
 * Every figure rendered here comes from the server (lib/billing/payments.ts:
 * getInvoiceSettlement) — the panel never derives a balance of its own. The
 * client-side balance check below is UX only; recordPayment re-locks the
 * invoice and recomputes the balance from the captured rows before it accepts
 * anything.
 */

/** Serialisable mirror of RecordedPayment — createdAt crosses as an ISO string. */
export type PaymentRow = {
  id: string
  method: string
  amount: string
  status: string
  collectedByName: string | null
  createdAt: string
}

export type SettlementView = {
  invoiceId: string
  invoiceNumber: string
  status: string
  total: number
  paid: number
  balance: number
  payments: PaymentRow[]
  payable: boolean
}

/** The three counter tenders. 'online' and 'wallet' are deliberately absent. */
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'upi', label: 'UPI' },
] as const

const METHOD_LABELS: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online', wallet: 'Wallet' }
const inputCls =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'

/** Whole paise, so no balance is ever compared as a float. */
const paise = (n: number) => Math.round(round2(n) * 100)

export function PaymentPanel({
  settlement,
  timeZone,
  currency,
}: {
  settlement: SettlementView
  timeZone: string
  currency: string
}) {
  const router = useRouter()
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('cash')
  // Defaults to the outstanding balance; the cashier can type a smaller amount.
  const [amountText, setAmountText] = useState(settlement.balance.toFixed(2))
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const money = (n: number | string) => formatMoney(n, currency)
  const amount = Number(amountText)
  const settled = paise(settlement.balance) <= 0 || settlement.status === 'paid'

  const amountError =
    amountText.trim() === '' || !Number.isFinite(amount)
      ? 'Enter an amount.'
      : paise(amount) <= 0
        ? 'Enter an amount greater than zero.'
        : paise(amount) > paise(settlement.balance)
          ? `Cannot exceed the ${money(settlement.balance)} balance.`
          : null

  function submit() {
    if (settled || pending || amountError) return
    setError(null)
    start(async () => {
      const r = await recordPayment({
        invoiceId: settlement.invoiceId,
        method,
        amount,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      // Server-recomputed figures land via the refreshed page props.
      router.refresh()
    })
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Wallet size={15} /> Payment
        </h2>
        {settled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            <BadgeCheck size={14} /> Paid
          </span>
        ) : (
          <span className="rounded-full border px-2.5 py-1 text-xs font-medium capitalize">
            {settlement.status}
          </span>
        )}
      </div>

      {/* ── balance due ── */}
      <dl className="mt-4 space-y-1.5 text-sm">
        <Line k="Total" v={money(settlement.total)} />
        <Line k="Paid" v={money(settlement.paid)} muted />
        <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
          <dt>Balance</dt>
          <dd className="tabular-nums">{money(settlement.balance)}</dd>
        </div>
      </dl>

      {/* ── recorded payments ── */}
      {settlement.payments.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recorded payments
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {settlement.payments.map((p) => (
              <li key={p.id} className="flex items-baseline justify-between gap-3">
                <span>
                  {METHOD_LABELS[p.method] ?? p.method}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {timeInZone(p.createdAt, timeZone)}
                    {p.collectedByName && ` · ${p.collectedByName}`}
                    {p.status !== 'captured' && ` · ${p.status}`}
                  </span>
                </span>
                <span
                  className={`shrink-0 tabular-nums ${p.status === 'captured' ? 'font-medium' : 'text-muted-foreground line-through'}`}
                >
                  {money(p.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ── add payment ── */}
      {settled ? (
        <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">
          This invoice is settled in full. No further payment can be recorded.
        </p>
      ) : (
        <div className="mt-4 space-y-3 border-t pt-3">
          <div>
            <label htmlFor="method" className="text-sm font-medium">
              Method
            </label>
            <select
              id="method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              disabled={pending}
              className={`mt-1 ${inputCls}`}
            >
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="amount" className="text-sm font-medium">
              Amount
            </label>
            <input
              id="amount"
              type="number"
              min={0.01}
              step="0.01"
              max={settlement.balance}
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              disabled={pending}
              className={`mt-1 ${inputCls}`}
            />
            {amountError && <p className="mt-1 text-xs text-destructive">{amountError}</p>}
          </div>

          <button
            onClick={submit}
            disabled={pending || Boolean(amountError)}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Recording…' : 'Record payment'}
          </button>
          <p className="text-center text-xs text-muted-foreground">
            The balance is re-checked on the server before the payment is taken.
          </p>
        </div>
      )}
    </section>
  )
}

function Line({ k, v, muted = false }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${muted ? 'text-muted-foreground' : ''}`}>
      <dt>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}
