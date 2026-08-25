'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, MapPin, Check, X, Loader2, ShoppingBag } from 'lucide-react'
import { acceptOnlineOrder, rejectOnlineOrder } from '@/lib/actions/orders'
import { saveAutoAcceptOnlineOrders } from '@/lib/actions/order-settings'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { formatMoney } from '@/lib/format'

export type IncomingOrderItem = {
  itemId: string
  itemName: string
  qty: number
  specialInstructions: string | null
  lineTotal: string
}
export type IncomingOrder = {
  orderId: string
  orderNumber: string
  createdAt: string
  stationName: string | null
  items: IncomingOrderItem[]
}

/** Same polling approach as components/kitchen/KitchenQueue.tsx — a handful
 *  of live orders on a staff tablet, no websockets yet. */
const POLL_MS = 5000
const CLOCK_MS = 15000

function elapsedLabel(createdAt: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export function IncomingOrdersQueue({
  orders,
  currency,
  autoAcceptEnabled,
  canManageSettings,
}: {
  orders: IncomingOrder[]
  currency: string
  autoAcceptEnabled: boolean
  canManageSettings: boolean
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [now, setNow] = useState(() => Date.now())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<IncomingOrder | null>(null)
  const [autoAccept, setAutoAccept] = useState(autoAcceptEnabled)
  const [savingSetting, setSavingSetting] = useState(false)
  const [, startTransition] = useTransition()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [router])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  async function handleAccept(order: IncomingOrder) {
    const ok = await confirm({
      title: `Accept order ${order.orderNumber}?`,
      description: 'It will move into the normal kitchen flow right away.',
      confirmText: 'Accept',
      variant: 'default',
    })
    if (!ok) return

    setError(null)
    setPendingId(order.orderId)
    startTransition(async () => {
      const r = await acceptOnlineOrder(order.orderId)
      if (r.error) setError(r.error)
      else router.refresh()
      setPendingId(null)
    })
  }

  function handleRejected() {
    setRejecting(null)
    router.refresh()
  }

  async function handleToggleAutoAccept(value: boolean) {
    setAutoAccept(value)
    setSavingSetting(true)
    setError(null)
    const r = await saveAutoAcceptOnlineOrders(value)
    if (r.error) {
      setError(r.error)
      setAutoAccept(!value)
    }
    setSavingSetting(false)
  }

  return (
    <div className="mt-6 space-y-4">
      {canManageSettings && (
        <label className="flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm">
          <input
            type="checkbox"
            checked={autoAccept}
            disabled={savingSetting}
            onChange={(e) => handleToggleAutoAccept(e.target.checked)}
          />
          Auto-accept online orders
          {savingSetting && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        </label>
      )}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {orders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-base text-muted-foreground">
          No orders waiting. New online orders will appear here automatically.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => {
            const isPending = pendingId === order.orderId
            const total = order.items.reduce((sum, i) => sum + Number(i.lineTotal), 0)
            return (
              <div key={order.orderId} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-base font-semibold">
                    <ShoppingBag size={15} className="text-primary" /> {order.orderNumber}
                  </span>
                  <span className="text-sm font-bold text-primary">{formatMoney(total, currency)}</span>
                </div>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock size={12} /> waiting {elapsedLabel(order.createdAt, now)}
                  {order.stationName && (
                    <>
                      {' '}
                      · <MapPin size={12} /> {order.stationName}
                    </>
                  )}
                </p>

                <ul className="mt-3 space-y-1 text-sm">
                  {order.items.map((item) => (
                    <li key={item.itemId}>
                      <span className="font-medium">
                        {item.qty}× {item.itemName}
                      </span>
                      {item.specialInstructions && (
                        <span className="block text-xs text-muted-foreground">— {item.specialInstructions}</span>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRejecting(order)}
                    disabled={isPending}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3.5 py-2.5 text-sm font-medium text-destructive shadow-sm transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X size={16} /> Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAccept(order)}
                    disabled={isPending}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPending ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    Accept
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rejecting && (
        <RejectDialog order={rejecting} onClose={() => setRejecting(null)} onRejected={handleRejected} />
      )}
    </div>
  )
}

/** Rejecting needs a reason (see rejectOrderCore) — ConfirmDialog has no text
 *  input, so this is a small bespoke dialog rather than stretching that
 *  component for the one case in the app that needs free text. */
function RejectDialog({
  order,
  onClose,
  onRejected,
}: {
  order: IncomingOrder
  onClose: () => void
  onRejected: () => void
}) {
  useBodyScrollLock()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleReject() {
    const trimmed = reason.trim()
    if (!trimmed) {
      setError('Enter a reason for the customer.')
      return
    }
    setError(null)
    startTransition(async () => {
      const r = await rejectOnlineOrder(order.orderId, trimmed)
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
        <h2 className="text-base font-semibold">Reject order {order.orderNumber}?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This cancels the order and its kitchen ticket. The reason is kept with the order.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Kitchen is closed, item out of stock..."
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
            Reject order
          </button>
        </div>
      </div>
    </div>
  )
}
