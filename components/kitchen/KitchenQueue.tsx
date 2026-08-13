'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, Flame, CheckCircle2, Bell, Loader2, type LucideIcon } from 'lucide-react'
import { updateKotStatus } from '@/lib/actions/kots'
import type { KotStatus } from '@/lib/kots/service'

export type { KotStatus }
export type KotTicketItem = {
  itemId: string
  itemName: string
  qty: number
  specialInstructions: string | null
}
export type KotTicket = {
  kotId: string
  kotNumber: string
  status: KotStatus
  createdAt: string
  orderNumber: string
  items: KotTicketItem[]
}

/** Poll for new/updated tickets. Simplest workable approach for a handful of
 * live tickets on a kitchen tablet — real-time websockets are a later
 * milestone (AROS-96). */
const POLL_MS = 5000
/** How often the "waiting Xm" label re-renders between polls. */
const CLOCK_MS = 15000

const STATUS_LABEL: Record<KotStatus, string> = {
  pending: 'Pending',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
}
const STATUS_BADGE: Record<KotStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-600',
  preparing: 'bg-blue-500/10 text-blue-600',
  ready: 'bg-emerald-500/10 text-emerald-600',
  served: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
}

/** The one legal forward move the dashboard offers for each status. */
const NEXT_ACTION: Partial<Record<KotStatus, { status: KotStatus; label: string; icon: LucideIcon }>> = {
  pending: { status: 'preparing', label: 'Start preparing', icon: Flame },
  preparing: { status: 'ready', label: 'Mark ready', icon: CheckCircle2 },
  ready: { status: 'served', label: 'Mark served', icon: Bell },
}

function elapsedLabel(createdAt: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export function KitchenQueue({ tickets }: { tickets: KotTicket[] }) {
  const router = useRouter()
  const [now, setNow] = useState(() => Date.now())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [router])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  function advance(kotId: string, status: KotStatus) {
    setError(null)
    setPendingId(kotId)
    startTransition(async () => {
      const r = await updateKotStatus(kotId, status)
      if (r.error) setError(r.error)
      else router.refresh()
      setPendingId(null)
    })
  }

  if (tickets.length === 0) {
    return (
      <div className="mt-8 rounded-xl border border-dashed border-border p-12 text-center text-base text-muted-foreground">
        No active tickets. New orders will appear here automatically.
      </div>
    )
  }

  return (
    <div className="mt-6 space-y-4">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tickets.map((ticket) => {
          const next = NEXT_ACTION[ticket.status]
          const Icon = next?.icon
          const isPending = pendingId === ticket.kotId
          return (
            <div key={ticket.kotId} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-semibold">{ticket.kotNumber}</span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[ticket.status]}`}
                >
                  {STATUS_LABEL[ticket.status]}
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <Clock size={12} /> waiting {elapsedLabel(ticket.createdAt, now)} · order {ticket.orderNumber}
              </p>

              <ul className="mt-3 space-y-1 text-sm">
                {ticket.items.map((item) => (
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

              {next && Icon && (
                <button
                  type="button"
                  onClick={() => advance(ticket.kotId, next.status)}
                  disabled={isPending}
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPending ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
                  {next.label}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
