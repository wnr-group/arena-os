'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { topUpCustomerWallet } from '@/lib/actions/payments'
import { formatMoney } from '@/lib/format'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'

/**
 * Sell wallet credit from the customer profile.
 *
 * The balance shown beside it is ledger-derived by the server (walletBalance()
 * over wallet_transactions); this component never computes or caches one. It
 * sends a customer id, an amount and a tender — the server raises the invoice,
 * captures the payment and credits the ledger in one transaction, then the page
 * refresh re-reads the balance from the ledger again.
 */

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'upi', label: 'UPI' },
] as const

export function WalletTopUp({
  customerId,
  currency,
  canSell,
}: {
  customerId: string
  currency: string
  /** Cashier and up. The action re-checks — hiding a button is not authorization. */
  canSell: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [amountText, setAmountText] = useState('')
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('cash')
  /**
   * One retry token per ATTEMPT, minted lazily on submit.
   *
   * A ref rather than state, and generated at submit rather than at render:
   * rendering is also what runs during SSR, so a render-time token would be
   * minted on the server and thrown away on hydration. Cleared after a success
   * so a DELIBERATE second top-up is not mistaken for a retry of the first;
   * KEPT after a failure, so retrying a failed attempt reuses it.
   */
  const keyRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (!canSell) return null

  const amount = Number(amountText)
  const amountError =
    amountText.trim() === '' || !Number.isFinite(amount)
      ? 'Enter an amount.'
      : amount <= 0
        ? 'Enter an amount greater than zero.'
        : null

  function submit() {
    if (pending || amountError) return
    setError(null)
    setNotice(null)
    start(async () => {
      keyRef.current ??= newIdempotencyKey()
      const r = await topUpCustomerWallet({
        customerId,
        amount,
        method,
        idempotencyKey: keyRef.current,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      setNotice(
        `${formatMoney(amount, currency)} added${r.invoiceNumber ? ` · ${r.invoiceNumber}` : ''}.` +
          (r.balance !== undefined ? ` Balance ${formatMoney(r.balance, currency)}.` : ''),
      )
      setAmountText('')
      keyRef.current = null
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:opacity-50"
      >
        {open ? <X size={14} /> : <Plus size={14} />} {open ? 'Cancel' : 'Top up'}
      </button>

      {notice && !open && <p className="mt-1.5 text-xs text-emerald-600">{notice}</p>}

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border p-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="topup-amount" className="text-xs font-medium">
                Amount ({currency})
              </label>
              <input
                id="topup-amount"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                disabled={pending}
                placeholder="1000"
                className={`mt-1 ${input}`}
              />
            </div>
            <div>
              <label htmlFor="topup-method" className="text-xs font-medium">
                Paid by
              </label>
              <select
                id="topup-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                disabled={pending}
                className={`mt-1 ${input}`}
              >
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            The customer pays now; a GST invoice is raised for the top-up and the credit is added
            to their wallet.
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || Boolean(amountError)}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Taking payment…' : 'Take payment & add credit'}
          </button>
        </div>
      )}
    </div>
  )
}
