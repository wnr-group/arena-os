'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { requestVoidOrderItem } from '@/lib/actions/orders'

/**
 * Raise a void/comp request on one order_items line (M17 #6).
 *
 * Bespoke dialog rather than ConfirmDialog for the same reason
 * IncomingOrdersQueue's RejectDialog is: this needs free text, and the mode
 * choice (void vs comp) itself. requestVoidOrderItem re-checks the role
 * server-side, so hiding the trigger button from ineligible roles (the
 * callers' job) is UX only, not the actual authorization boundary.
 *
 * A manager/owner's own request is applied immediately — requestVoidOrderItem
 * comes back with `status: 'approved'`; anyone else's sits in the manager
 * approval queue (`status: 'pending'`, /orders/void-requests) until a manager
 * decides it.
 */
export function VoidCompDialog({
  item,
  onClose,
  onDone,
}: {
  item: { itemId: string; itemName: string; qty: number }
  onClose: () => void
  onDone: (mode: 'void' | 'comp', status: 'pending' | 'approved') => void
}) {
  useBodyScrollLock()
  const [mode, setMode] = useState<'void' | 'comp'>('void')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit() {
    const trimmed = reason.trim()
    if (!trimmed) {
      setError('Enter a reason.')
      return
    }
    setError(null)
    startTransition(async () => {
      const r = await requestVoidOrderItem({ orderItemId: item.itemId, mode, reason: trimmed })
      if (r.error) setError(r.error)
      else onDone(mode, r.status ?? 'pending')
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
          Void or comp {item.qty}× {item.itemName}?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This takes the item off the tab. The reason is kept with the order for the void/comp report.
        </p>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => setMode('void')}
            aria-pressed={mode === 'void'}
            className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm font-medium transition disabled:opacity-50 ${
              mode === 'void' ? 'border-destructive bg-destructive/10 text-destructive' : 'border-border hover:bg-muted'
            }`}
          >
            Void
            <span className="block text-xs font-normal opacity-80">Ordered by mistake</span>
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setMode('comp')}
            aria-pressed={mode === 'comp'}
            className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm font-medium transition disabled:opacity-50 ${
              mode === 'comp' ? 'border-violet-500 bg-violet-500/10 text-violet-600' : 'border-border hover:bg-muted'
            }`}
          >
            Comp
            <span className="block text-xs font-normal opacity-80">Given free</span>
          </button>
        </div>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Fired to the wrong table, guest complaint..."
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
            onClick={handleSubmit}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {mode === 'void' ? 'Void item' : 'Comp item'}
          </button>
        </div>
      </div>
    </div>
  )
}
