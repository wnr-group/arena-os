'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Ban, Check, Clock, Gift, Loader2, User, X } from 'lucide-react'
import { decideVoidRequest } from '@/lib/actions/orders'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { formatMoney } from '@/lib/format'

export type VoidRequest = {
  requestId: string
  mode: 'void' | 'comp'
  reason: string
  requestedAt: string
  requestedByName: string | null
  itemName: string
  qty: number
  amount: string
  orderNumber: string
  bookingNumber: string | null
  tableName: string | null
}

/** Same polling approach as IncomingOrdersQueue — a handful of live requests
 *  on a manager's tablet, no websockets yet. */
const POLL_MS = 5000
const CLOCK_MS = 15000

function elapsedLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

export function VoidRequestsQueue({ requests, currency }: { requests: VoidRequest[]; currency: string }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [now, setNow] = useState(() => Date.now())
  const [actingId, setActingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<VoidRequest | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [router])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  async function handleApprove(req: VoidRequest) {
    const verb = req.mode === 'comp' ? 'Comp' : 'Void'
    const ok = await confirm({
      title: `${verb} ${req.qty}× ${req.itemName}?`,
      description: `This removes ${formatMoney(Number(req.amount), currency)} from the tab. Requested by ${req.requestedByName ?? 'a staff member'}: "${req.reason}"`,
      confirmText: `Approve ${verb.toLowerCase()}`,
      variant: 'default',
    })
    if (!ok) return

    setError(null)
    setActingId(req.requestId)
    startTransition(async () => {
      const r = await decideVoidRequest({ requestId: req.requestId, decision: 'approve' })
      if (r.error) setError(r.error)
      else router.refresh()
      setActingId(null)
    })
  }

  function handleRejected() {
    setRejecting(null)
    router.refresh()
  }

  return (
    <div className="mt-6 space-y-4">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-base text-muted-foreground">
          No requests waiting. Void/comp requests raised by staff will appear here automatically.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {requests.map((req) => {
            const isActing = actingId === req.requestId
            return (
              <div key={req.requestId} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                      req.mode === 'comp' ? 'bg-violet-500/10 text-violet-600' : 'bg-destructive/10 text-destructive'
                    }`}
                  >
                    {req.mode === 'comp' ? <Gift size={12} /> : <Ban size={12} />}
                    {req.mode === 'comp' ? 'Comp' : 'Void'}
                  </span>
                  <span className="text-sm font-bold">{formatMoney(Number(req.amount), currency)}</span>
                </div>

                <p className="mt-2 text-base font-semibold">
                  {req.qty}× {req.itemName}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {req.tableName ? `${req.tableName} · ` : ''}
                  {req.bookingNumber ?? req.orderNumber}
                </p>

                <p className="mt-2 rounded-md bg-muted/60 px-2.5 py-2 text-sm italic text-foreground">
                  &ldquo;{req.reason}&rdquo;
                </p>

                <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                  <User size={12} /> {req.requestedByName ?? 'Unknown staff'}
                  {' · '}
                  <Clock size={12} /> {elapsedLabel(req.requestedAt, now)}
                </p>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRejecting(req)}
                    disabled={isActing}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3.5 py-2.5 text-sm font-medium text-destructive shadow-sm transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X size={16} /> Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApprove(req)}
                    disabled={isActing}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isActing ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    Approve
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rejecting && (
        <RejectRequestDialog request={rejecting} onClose={() => setRejecting(null)} onRejected={handleRejected} />
      )}
    </div>
  )
}

/** Rejection note is optional (unlike the waiter's original reason, which is
 *  already shown above) — ConfirmDialog has no text input, so this is a
 *  small bespoke dialog, same pattern as IncomingOrdersQueue's RejectDialog. */
function RejectRequestDialog({
  request,
  onClose,
  onRejected,
}: {
  request: VoidRequest
  onClose: () => void
  onRejected: () => void
}) {
  useBodyScrollLock()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleReject() {
    setError(null)
    startTransition(async () => {
      const r = await decideVoidRequest({ requestId: request.requestId, decision: 'reject', note: note.trim() || undefined })
      if (r.error) setError(r.error)
      else onRejected()
    })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={pending ? undefined : onClose}
      role="alertdialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">
          Reject {request.mode} of {request.qty}× {request.itemName}?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The item stays on the tab, billable as normal. An optional note is kept with the request.
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note, e.g. reason for declining..."
          rows={3}
          autoFocus
          disabled={pending}
          className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
        />
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-destructive px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={handleReject}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Reject request
          </button>
        </div>
      </div>
    </div>
  )
}
