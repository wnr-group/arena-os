'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Ban, RotateCcw, X } from 'lucide-react'
import { refundPayment, voidInvoice } from '@/lib/actions/refunds'
import { round2 } from '@/lib/billing/pricing'
import { formatMoney } from '@/lib/format'

/**
 * Manager-only refund and void controls for an invoice.
 *
 * The page decides whether to render this at all (isManager), but that is
 * presentation, not security: refundPayment/voidInvoice both call
 * requireManager() server-side, and the refunds table is additionally guarded
 * by the auth_is_manager RLS policy.
 *
 * Every figure here comes from the server. The client-side caps below are UX;
 * the actions re-lock the row and recompute the refundable amount.
 */

export type ActionablePayment = {
  id: string
  method: string
  amount: string
  status: string
  refunded: string
  refundable: string
}

const inputCls =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online', wallet: 'Wallet' }
const paise = (n: number) => Math.round(round2(n) * 100)

export function InvoiceActions({
  invoiceId,
  invoiceStatus,
  payments,
  outstandingCaptured,
  currency,
}: {
  invoiceId: string
  invoiceStatus: string
  payments: ActionablePayment[]
  /** Captured money not yet refunded — non-zero blocks the void. */
  outstandingCaptured: string
  currency: string
}) {
  const [dialog, setDialog] = useState<'refund' | 'void' | null>(null)
  const money = (v: string | number) => formatMoney(v, currency)

  const refundable = payments.filter((p) => paise(Number(p.refundable)) > 0)
  const alreadyVoid = invoiceStatus === 'void'
  const voidBlocked = paise(Number(outstandingCaptured)) > 0

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setDialog('refund')}
          disabled={refundable.length === 0}
          title={refundable.length === 0 ? 'Nothing left to refund on this invoice' : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw size={15} /> Refund
        </button>
        <button
          onClick={() => setDialog('void')}
          disabled={alreadyVoid}
          title={alreadyVoid ? 'This invoice is already void' : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
        >
          <Ban size={15} /> Void invoice
        </button>
      </div>

      {dialog === 'refund' && (
        <RefundDialog
          payments={refundable}
          money={money}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'void' && (
        <VoidDialog
          invoiceId={invoiceId}
          blockedBy={voidBlocked ? outstandingCaptured : null}
          money={money}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

function RefundDialog({
  payments,
  money,
  onClose,
}: {
  payments: ActionablePayment[]
  money: (v: string | number) => string
  onClose: () => void
}) {
  const router = useRouter()
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '')
  const selected = payments.find((p) => p.id === paymentId)
  // Defaults to everything still refundable; a partial refund is just a smaller
  // number typed here.
  const [amountText, setAmountText] = useState(selected?.refundable ?? '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const amount = Number(amountText)
  const max = Number(selected?.refundable ?? 0)
  const amountError =
    !selected
      ? 'Select a payment.'
      : amountText.trim() === '' || !Number.isFinite(amount)
        ? 'Enter an amount.'
        : paise(amount) <= 0
          ? 'Enter an amount greater than zero.'
          : paise(amount) > paise(max)
            ? `Cannot exceed the ${money(max)} still refundable.`
            : null
  const reasonError = reason.trim() ? null : 'A reason is required.'

  function pick(id: string) {
    setPaymentId(id)
    setAmountText(payments.find((p) => p.id === id)?.refundable ?? '')
  }

  function submit() {
    if (amountError || reasonError || pending) return
    setError(null)
    start(async () => {
      const r = await refundPayment({ paymentId, amount, reason: reason.trim() })
      if (r.error) {
        setError(r.error)
        return
      }
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal title="Refund payment" onClose={onClose} pending={pending}>
      {payments.length > 1 && (
        <div>
          <label htmlFor="payment" className="text-sm font-medium">
            Payment
          </label>
          <select
            id="payment"
            value={paymentId}
            onChange={(e) => pick(e.target.value)}
            disabled={pending}
            className={`mt-1 ${inputCls}`}
          >
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {METHOD_LABEL[p.method] ?? p.method} · {money(p.amount)}
                {paise(Number(p.refunded)) > 0 && ` (${money(p.refunded)} refunded)`}
              </option>
            ))}
          </select>
        </div>
      )}

      {selected && (
        <dl className="rounded-md border bg-muted/40 p-3 text-sm">
          <Row k="Payment" v={`${METHOD_LABEL[selected.method] ?? selected.method} · ${money(selected.amount)}`} />
          <Row k="Already refunded" v={money(selected.refunded)} />
          <Row k="Refundable now" v={money(selected.refundable)} strong />
        </dl>
      )}

      <div>
        <label htmlFor="refund-amount" className="text-sm font-medium">
          Refund amount
        </label>
        <input
          id="refund-amount"
          type="number"
          min={0.01}
          step="0.01"
          max={max}
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          disabled={pending}
          className={`mt-1 ${inputCls}`}
        />
        {amountError && <p className="mt-1 text-xs text-destructive">{amountError}</p>}
      </div>

      <div>
        <label htmlFor="refund-reason" className="text-sm font-medium">
          Reason
        </label>
        <input
          id="refund-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          placeholder="e.g. Customer overcharged"
          className={`mt-1 ${inputCls}`}
        />
        {!reason.trim() && <p className="mt-1 text-xs text-muted-foreground">Recorded on the refund and in the audit log.</p>}
      </div>

      {error && <Alert>{error}</Alert>}

      <Buttons
        onClose={onClose}
        pending={pending}
        disabled={Boolean(amountError || reasonError)}
        confirmLabel={pending ? 'Refunding…' : 'Confirm refund'}
        onConfirm={submit}
      />
    </Modal>
  )
}

function VoidDialog({
  invoiceId,
  blockedBy,
  money,
  onClose,
}: {
  invoiceId: string
  blockedBy: string | null
  money: (v: string | number) => string
  onClose: () => void
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function submit() {
    if (!reason.trim() || pending || blockedBy) return
    setError(null)
    start(async () => {
      const r = await voidInvoice({ invoiceId, reason: reason.trim() })
      if (r.error) {
        setError(r.error)
        return
      }
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal title="Void invoice" onClose={onClose} pending={pending}>
      {blockedBy ? (
        <Alert>
          This invoice cannot be voided until its captured payments are fully refunded.{' '}
          {money(blockedBy)} is still held. Refund the payment first, then void.
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          Are you sure you want to void this invoice? It stays on record as a voided
          document — nothing is deleted, and no payment is refunded by this action.
        </p>
      )}

      <div>
        <label htmlFor="void-reason" className="text-sm font-medium">
          Reason
        </label>
        <input
          id="void-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending || Boolean(blockedBy)}
          placeholder="e.g. Incorrect bill"
          className={`mt-1 ${inputCls}`}
        />
        {!reason.trim() && !blockedBy && (
          <p className="mt-1 text-xs text-muted-foreground">Recorded in the audit log.</p>
        )}
      </div>

      {error && <Alert>{error}</Alert>}

      <Buttons
        onClose={onClose}
        pending={pending}
        disabled={!reason.trim() || Boolean(blockedBy)}
        confirmLabel={pending ? 'Voiding…' : 'Void invoice'}
        danger
        onConfirm={submit}
      />
    </Modal>
  )
}

/** Same overlay shape as the booking detail modal in BookingsView. */
function Modal({
  title,
  onClose,
  pending,
  children,
}: {
  title: string
  onClose: () => void
  pending: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Buttons({
  onClose,
  onConfirm,
  pending,
  disabled,
  confirmLabel,
  danger = false,
}: {
  onClose: () => void
  onConfirm: () => void
  pending: boolean
  disabled: boolean
  confirmLabel: string
  danger?: boolean
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button
        onClick={onClose}
        disabled={pending}
        className="rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={pending || disabled}
        className={`rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${
          danger
            ? 'bg-destructive text-white hover:opacity-90'
            : 'bg-primary text-primary-foreground hover:opacity-90'
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  )
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  )
}

function Row({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{v}</dd>
    </div>
  )
}
