'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ShoppingBag, ChefHat, BellRing, CheckCircle2, XCircle, Loader2, type LucideIcon } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { PublicOrderStatus, CustomerOrderStatus } from '@/lib/orders/public-status'

/** Same polling idiom as KitchenQueue/IncomingOrdersQueue — a placeholder
 *  until realtime (M10) lands. Stopped once the order reaches a terminal
 *  status, so a finished order's page doesn't poll forever. */
const POLL_MS = 5000
const TERMINAL: CustomerOrderStatus[] = ['served', 'rejected', 'cancelled']

const STEPS: { status: CustomerOrderStatus; label: string; icon: LucideIcon }[] = [
  { status: 'placed', label: 'Placed', icon: ShoppingBag },
  { status: 'preparing', label: 'Preparing', icon: ChefHat },
  { status: 'ready', label: 'Ready', icon: BellRing },
  { status: 'served', label: 'Served', icon: CheckCircle2 },
]
const STEP_INDEX: Partial<Record<CustomerOrderStatus, number>> = {
  placed: 0,
  preparing: 1,
  ready: 2,
  served: 3,
}

export function OrderStatusTracker({ order, currency }: { order: PublicOrderStatus; currency: string }) {
  const router = useRouter()
  const total = order.items.reduce((sum, i) => sum + Number(i.lineTotal), 0)

  useEffect(() => {
    if (TERMINAL.includes(order.status)) return
    const id = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [router, order.status])

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <div className="text-center">
        <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground">
          Order #{order.orderNumber}
        </p>
      </div>

      <div className="mt-6">
        {order.status === 'awaiting_payment' && <StatusBanner icon={Loader2} spin label="Confirming your payment…" />}
        {order.status === 'rejected' && (
          <StatusBanner
            icon={XCircle}
            tone="destructive"
            label="This order couldn't be accepted"
            detail={order.rejectionReason ?? undefined}
          />
        )}
        {order.status === 'cancelled' && <StatusBanner icon={XCircle} tone="destructive" label="Order cancelled" />}
        {STEP_INDEX[order.status] !== undefined && <StepTracker status={order.status} />}
      </div>

      <div className="mt-6 space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
        {order.items.map((item) => (
          <div key={item.itemId} className="flex items-start justify-between gap-3 text-sm">
            <div>
              <span className="font-semibold text-foreground">
                {item.qty}× {item.itemName}
              </span>
              {item.specialInstructions && (
                <span className="block text-xs text-muted-foreground">— {item.specialInstructions}</span>
              )}
            </div>
            <span className="shrink-0 font-semibold text-foreground">{formatMoney(item.lineTotal, currency)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border/70 pt-3 text-sm font-bold">
          <span>Total</span>
          <span className="text-primary">{formatMoney(total, currency)}</span>
        </div>
      </div>
    </div>
  )
}

function StatusBanner({
  icon: Icon,
  label,
  detail,
  tone = 'primary',
  spin = false,
}: {
  icon: LucideIcon
  label: string
  detail?: string
  tone?: 'primary' | 'destructive'
  spin?: boolean
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
      <span
        className={`flex size-14 items-center justify-center rounded-full ${
          tone === 'destructive' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
        }`}
      >
        <Icon size={26} className={spin ? 'animate-spin' : undefined} />
      </span>
      <p className="mt-4 text-base font-bold text-foreground">{label}</p>
      {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
    </div>
  )
}

function StepTracker({ status }: { status: CustomerOrderStatus }) {
  const currentIndex = STEP_INDEX[status] ?? 0
  return (
    <div className="flex items-start justify-between rounded-2xl border border-border bg-card p-5 shadow-sm">
      {STEPS.map((step, i) => {
        const done = i < currentIndex
        const active = i === currentIndex
        const Icon = step.icon
        return (
          <div key={step.status} className="flex flex-1 flex-col items-center text-center">
            <div className="flex w-full items-center">
              <div className={`h-0.5 flex-1 ${i === 0 ? 'invisible' : done || active ? 'bg-primary' : 'bg-border'}`} />
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-full border-2 ${
                  done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground/50'
                }`}
              >
                <Icon size={16} />
              </span>
              <div
                className={`h-0.5 flex-1 ${i === STEPS.length - 1 ? 'invisible' : done ? 'bg-primary' : 'bg-border'}`}
              />
            </div>
            <span
              className={`mt-2 text-xs font-semibold ${active ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground/60'}`}
            >
              {step.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
