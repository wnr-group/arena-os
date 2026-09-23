'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { BadgeCheck, Loader2, Wallet } from 'lucide-react'
import { recordPayment, payInvoiceFromWallet } from '@/lib/actions/payments'
import { round2 } from '@/lib/billing/pricing'
import { formatMoney, timeInZone } from '@/lib/format'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'

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
  /** M18 #3 — '0.00' when this tender carried no tip. */
  tipAmount: string
  tipRecipientName: string | null
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
  /** Sum of every captured payment's tip (M18 #3) — display only, never
   *  part of total/paid/balance. */
  tipTotal: number
  /** Bill-level comp/discount (M18 #5), if any — display only. Already
   *  folded into `total` at issue time, never a separate deduction here. */
  compAmount: number
  compReason: string | null
}

/**
 * Counter tenders plus the wallet. 'online' stays absent — a gateway payment
 * is confirmed by its webhook, never keyed in here.
 *
 * 'wallet' is offered but takes a DIFFERENT server action: it must debit the
 * ledger in the same transaction as the payment, which recordPayment() cannot
 * do. See lib/billing/wallet-payments.ts.
 */
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'upi', label: 'UPI' },
  { value: 'wallet', label: 'Wallet' },
] as const

const METHOD_LABELS: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online', wallet: 'Wallet' }
const inputCls =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'

/** Whole paise, so no balance is ever compared as a float. */
const paise = (n: number) => Math.round(round2(n) * 100)

/** Cashier panel for recording one more tender against an invoice and showing the running balance until it settles. */
export function PaymentPanel({
  settlement,
  wallet,
  staff,
  isRestaurant,
  timeZone,
  currency,
  completesBooking = false,
}: {
  settlement: SettlementView
  /**
   * True when fully settling THIS invoice would complete the whole booking —
   * i.e. a single (non-split) bill, or the last still-owing check of a split.
   * Resolved by BillScreen (which alone knows every sibling check). When a
   * tender clears the full balance and this is true, the button says so, and
   * the server completes the booking in the same transaction as the payment
   * (lib/actions/payments.ts → completeBookingIfFullySettled). Display only —
   * the server re-checks every check before it flips the booking.
   */
  completesBooking?: boolean
  /**
   * The customer's ledger balance and what may be spent here, resolved
   * server-side. Null when the bill has no customer, in which case the
   * wallet tender is unavailable. DISPLAY ONLY — every limit below is
   * re-checked under a lock by the action.
   */
  wallet: { balance: number; maxSpendable: number } | null
  /** Active staff, for the optional tip-recipient picker (M18 #3). */
  staff: { id: string; name: string }[]
  /** M18's tip (and the cash-tendered/change-due flow, M18 #4) is
   *  restaurant-only, same as split bill and service charge — hides both
   *  inputs entirely for every other tenant type. */
  isRestaurant: boolean
  timeZone: string
  currency: string
}) {
  const router = useRouter()
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('cash')
  // Defaults to the outstanding balance; the cashier can type a smaller amount.
  const [amountText, setAmountText] = useState(settlement.balance.toFixed(2))
  // Tip (M18 #3) — a counter-tender-only extra, kept separate from `amount`
  // (never validated against the balance). Not offered for the wallet
  // tender, which takes a separate ledger-aware action that doesn't accept
  // one — see submit() below.
  const [tipText, setTipText] = useState('')
  const [tipRecipientId, setTipRecipientId] = useState('')
  /**
   * Cash tendered (M18 #4) — what the customer physically handed over, for
   * change-due only. This is the one sanctioned way an amount here can
   * exceed the balance: `amount` (below) still never does, still gets
   * clamped/rechecked exactly as before, and change is never written to
   * `payments` — it's display-only, computed client-side, same treatment as
   * the tip in that it never perturbs the balance arithmetic.
   */
  const [tenderedText, setTenderedText] = useState('')
  /**
   * One retry token per ATTEMPT, minted lazily on submit — see
   * lib/utils/idempotency-key.ts for why not crypto.randomUUID(), and why not
   * at render time. A double-click or a network retry reuses it, so the server
   * recognises the repeat and does not take the money twice; a deliberate
   * second tender gets a fresh one after the first succeeds.
   */
  const keyRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  /** Format a rupee amount for display in the tenant's own currency. */
  const money = (n: number | string) => formatMoney(n, currency)
  const amount = Number(amountText)
  const settled = paise(settlement.balance) <= 0 || settlement.status === 'paid'

  // This tender clears the FULL remaining balance of this invoice, and settling
  // this invoice is what completes the booking (single bill, or the last owing
  // split check) — so the button promises the completion the server will do.
  const willCompleteBooking =
    completesBooking && !settled && Number.isFinite(amount) && paise(amount) === paise(settlement.balance)

  // Wallet is selectable only when there is a customer with money to spend.
  const walletBalance = wallet?.balance ?? 0
  const walletMax = wallet?.maxSpendable ?? 0
  const walletAvailable = wallet !== null && paise(walletMax) > 0
  const usingWallet = method === 'wallet'

  // How much of `settlement.paid` arrived online, purely so the breakdown can
  // name it. Summed from the captured rows the server already sent.
  const onlinePaid = round2(
    settlement.payments
      .filter((p) => p.method === 'online' && p.status === 'captured')
      .reduce((n, p) => n + Number(p.amount), 0),
  )

  const amountError =
    amountText.trim() === '' || !Number.isFinite(amount)
      ? 'Enter an amount.'
      : paise(amount) <= 0
        ? 'Enter an amount greater than zero.'
        : paise(amount) > paise(settlement.balance)
          ? `Cannot exceed the ${money(settlement.balance)} balance.`
          : usingWallet && paise(amount) > paise(walletBalance)
            ? `Not enough wallet balance — ${money(walletBalance)} available.`
            : null

  // Tip is entirely separate from the balance check above — it can never
  // make `amountError` fire, since the server never compares it to the
  // invoice total either.
  const tip = tipText.trim() === '' ? 0 : Number(tipText)
  const tipError =
    tipText.trim() === '' || (Number.isFinite(tip) && paise(tip) >= 0) ? null : 'Enter a valid tip amount.'

  // Cash tendered (M18 #4) — restaurant + cash only. Optional: an empty
  // field means "exact amount", same as today. When filled, it must cover
  // `amount`; the difference is change handed back, never captured.
  const showTendered = isRestaurant && method === 'cash'
  const tendered = tenderedText.trim() === '' ? null : Number(tenderedText)
  const tenderedError =
    showTendered && tenderedText.trim() !== '' && !amountError
      ? !Number.isFinite(tendered) || paise(tendered as number) < paise(amount)
        ? 'Cash tendered must cover the amount being recorded.'
        : null
      : null
  const changeDue = showTendered && tendered !== null && !tenderedError ? round2(tendered - amount) : 0

  /** Validate the pending tender client-side, then record it via recordPayment or payInvoiceFromWallet. */
  function submit() {
    if (settled || pending || amountError || tipError || tenderedError) return
    setError(null)
    start(async () => {
      keyRef.current ??= newIdempotencyKey()
      const idempotencyKey = keyRef.current
      // Wallet takes the ledger-aware path; the counter tenders take the
      // existing one. Neither receives a balance from this component. Tip
      // is a counter-tender-only extra — payInvoiceFromWallet doesn't accept
      // one (see lib/billing/wallet-payments.ts, untouched by M18 #3).
      const r = usingWallet
        ? await payInvoiceFromWallet({ invoiceId: settlement.invoiceId, amount, idempotencyKey })
        : await recordPayment({
            invoiceId: settlement.invoiceId,
            method: method as 'cash' | 'card' | 'upi',
            amount,
            idempotencyKey,
            tipAmount: isRestaurant && tip > 0 ? tip : undefined,
            tipRecipientMembershipId: isRestaurant && tip > 0 && tipRecipientId ? tipRecipientId : undefined,
          })
      if (r.error) {
        setError(r.error)
        return
      }
      // Cleared, so a DELIBERATE second tender mints a fresh token instead of
      // being mistaken for a retry of the one that just succeeded.
      keyRef.current = null
      setTipText('')
      setTipRecipientId('')
      setTenderedText('')
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

      {/* ── balance due ──
          Every figure comes from getInvoiceSettlement(); the panel derives
          nothing. The deposit line below is a BREAKDOWN of `paid`, not a
          separate calculation — an online deposit (AROS-51) is an ordinary
          captured payment, so it is already inside `paid` and already netted
          off `balance`. Showing it explains why a ₹800 bill asks for ₹600. */}
      <dl className="mt-4 space-y-1.5 text-sm">
        <Line k="Total" v={money(settlement.total)} />
        {onlinePaid > 0 && <Line k="Deposit paid online" v={`− ${money(onlinePaid)}`} muted />}
        <Line k="Paid" v={money(settlement.paid)} muted />
        <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
          <dt>Balance</dt>
          <dd className="tabular-nums">{money(settlement.balance)}</dd>
        </div>
        {/* Tips are extra money on top — never part of Total/Paid/Balance
            above, shown separately so it's never mistaken for revenue. */}
        {settlement.tipTotal > 0 && (
          <div className="flex justify-between gap-4 pt-1 text-muted-foreground">
            <dt>Tips collected</dt>
            <dd className="tabular-nums">{money(settlement.tipTotal)}</dd>
          </div>
        )}
        {/* Bill-level comp (M18 #5) — already folded into `total` above (it's
            one component of the invoice's own discount), shown here only so
            the reason/amount stays visible after the bill is frozen. */}
        {settlement.compAmount > 0 && (
          <div className="flex justify-between gap-4 pt-1 text-muted-foreground">
            <dt>Comped{settlement.compReason ? ` · ${settlement.compReason}` : ''}</dt>
            <dd className="tabular-nums">− {money(settlement.compAmount)}</dd>
          </div>
        )}
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
                    {Number(p.tipAmount) > 0 &&
                      ` · +${money(p.tipAmount)} tip${p.tipRecipientName ? ` for ${p.tipRecipientName}` : ''}`}
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
              onChange={(e) => {
                setMethod(e.target.value as typeof method)
                setTenderedText('')
              }}
              disabled={pending}
              className={`mt-1 ${inputCls}`}
            >
              {METHODS.map((m) => (
                <option
                  key={m.value}
                  value={m.value}
                  // No customer, or nothing left to spend — the action
                  // refuses it anyway; this just says so up front.
                  disabled={m.value === 'wallet' && !walletAvailable}
                >
                  {m.label}
                  {m.value === 'wallet' && wallet ? ` · ${money(walletBalance)}` : ''}
                  {m.value === 'wallet' && !wallet ? ' · unavailable' : ''}
                </option>
              ))}
            </select>
            {usingWallet && wallet && (
              <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                <p>Wallet balance: {money(walletBalance)}</p>
                <p>Remaining invoice balance: {money(settlement.balance)}</p>
                {paise(walletBalance) < paise(settlement.balance) && (
                  <p className="text-amber-600">
                    Wallet covers {money(walletMax)} — settle the rest with another tender.
                  </p>
                )}
              </div>
            )}
            {usingWallet && !wallet && (
              <p className="mt-1.5 text-xs text-amber-600">
                This bill has no linked customer, so there is no wallet to charge.
              </p>
            )}
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

          {/* Cash tendered / change due (M18 #4) — restaurant-only, cash-only.
              The only sanctioned way to take more than the balance: `amount`
              above is still clamped, this is purely "what did they hand you"
              so the panel can tell the cashier what to hand back. */}
          {showTendered && (
            <div>
              <label htmlFor="tendered" className="text-sm font-medium">
                Cash tendered <span className="font-normal text-muted-foreground">(optional, for change)</span>
              </label>
              <input
                id="tendered"
                type="number"
                min={amount || 0}
                step="0.01"
                inputMode="decimal"
                value={tenderedText}
                onChange={(e) => setTenderedText(e.target.value)}
                disabled={pending}
                placeholder="0.00"
                className={`mt-1 ${inputCls}`}
              />
              {tenderedError && <p className="mt-1 text-xs text-destructive">{tenderedError}</p>}
              {changeDue > 0 && (
                <p className="mt-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  Change due: {money(changeDue)}
                </p>
              )}
            </div>
          )}

          {/* Tip (M18 #3) — restaurant-only, and a counter-tender-only extra
              hidden for the wallet tender (payInvoiceFromWallet doesn't
              accept one). */}
          {isRestaurant && !usingWallet && (
            <div>
              <label htmlFor="tip" className="text-sm font-medium">
                Tip <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input
                id="tip"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={tipText}
                onChange={(e) => setTipText(e.target.value)}
                disabled={pending}
                placeholder="0.00"
                className={`mt-1 ${inputCls}`}
              />
              {tipError && <p className="mt-1 text-xs text-destructive">{tipError}</p>}
              {tip > 0 && staff.length > 0 && (
                <select
                  value={tipRecipientId}
                  onChange={(e) => setTipRecipientId(e.target.value)}
                  disabled={pending}
                  className={`mt-1.5 ${inputCls}`}
                >
                  <option value="">Unattributed / pooled</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <button
            onClick={submit}
            disabled={pending || Boolean(amountError) || Boolean(tipError) || Boolean(tenderedError)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {pending
              ? 'Recording…'
              : willCompleteBooking
                ? 'Collect payment & complete booking'
                : 'Record payment'}
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
