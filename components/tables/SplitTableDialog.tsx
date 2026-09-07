'use client'

import { useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { splitTable } from '@/lib/actions/bookings'
import { formatMoney } from '@/lib/format'
import type { OrderSummary } from '@/components/bookings/BookingsView'

export function SplitTableDialog({
  bookingId,
  sourceTableName,
  sourceCoverCount,
  openOrders,
  freeTables,
  currency,
  onClose,
  onSplit,
}: {
  bookingId: string
  sourceTableName: string
  sourceCoverCount: number | null
  openOrders: OrderSummary[]
  freeTables: { id: string; name: string }[]
  currency: string
  onClose: () => void
  onSplit: (bookingId: string, bookingNumber: string, targetName: string) => void
}) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set())
  const [coverCount, setCoverCount] = useState('1')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // A split needs someone to move AND someone to stay — under 2 guests
  // there's no valid split at all. Same floor server-side (splitTableCore),
  // this is just the UI's earlier, friendlier stop.
  const canSplit = (sourceCoverCount ?? 0) >= 2
  const maxCovers = Math.max(1, (sourceCoverCount ?? 1) - 1)
  const covers = Number(coverCount)
  const coversValid = Number.isInteger(covers) && covers >= 1 && covers <= maxCovers

  function toggleOrder(orderId: string) {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  function submit() {
    setError(null)
    if (!targetId) {
      setError('Pick a table for the split-off tab.')
      return
    }
    if (!coversValid) {
      setError(`Guest count must be between 1 and ${maxCovers} — at least one guest has to stay at ${sourceTableName}.`)
      return
    }
    start(async () => {
      const r = await splitTable({
        sourceBookingId: bookingId,
        targetResourceId: targetId,
        orderIds: [...selectedOrderIds],
        coverCount: covers,
      })
      if (r.error) setError(r.error)
      else if (r.bookingId && r.bookingNumber) {
        onSplit(r.bookingId, r.bookingNumber, freeTables.find((t) => t.id === targetId)?.name ?? 'the new table')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Split {sourceTableName}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Move a subset of orders onto a new tab at a different table.
        </p>

        {!canSplit ? (
          <p className="mt-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {sourceTableName} has {sourceCoverCount ?? 0} guest{sourceCoverCount === 1 ? '' : 's'} — splitting needs at
            least 2, so there&apos;s someone to move and someone left behind.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground">Move to table</label>
              {freeTables.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No free tables right now.</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {freeTables.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTargetId(t.id)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition ${
                        targetId === t.id ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted'
                      }`}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Guests moving <span className="text-destructive">*</span>
              </label>
              <input
                className="mt-1 w-24 rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={1}
                max={maxCovers}
                inputMode="numeric"
                value={coverCount}
                onChange={(e) => setCoverCount(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {sourceTableName} currently has {sourceCoverCount ?? '—'} guests; at least 1 must stay.
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-muted-foreground">Orders to move</label>
              {openOrders.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No open orders — this splits off just the guests.</p>
              ) : (
                <div className="mt-1 space-y-1.5">
                  {openOrders.map((o) => {
                    // Voided/comped lines are struck through below and never bill — excluding
                    // them here keeps this total matching what the invoice will actually charge.
                    const total = o.items
                      .filter((it) => it.voidStatus === 'active')
                      .reduce((sum, it) => sum + Number(it.unitPrice) * it.qty, 0)
                    return (
                      <label
                        key={o.orderId}
                        className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selectedOrderIds.has(o.orderId)}
                          onChange={() => toggleOrder(o.orderId)}
                        />
                        <span className="flex-1">
                          <span className="flex justify-between font-medium">
                            <span>{o.orderNumber}</span>
                            <span>{formatMoney(total, currency)}</span>
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {o.items.map((it) => `${it.qty}× ${it.itemName}`).join(', ')}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <button
              onClick={submit}
              disabled={pending || !targetId || !coversValid}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {pending && <Loader2 size={15} className="animate-spin" />}
              Split off
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
