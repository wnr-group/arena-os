'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Clock3, Loader2, Plus, ReceiptText, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { SeatTableDialog } from './SeatTableDialog'
import { TakeOrderDialog, type CategoryOption, type MenuItemOption } from '@/components/orders/TakeOrderDialog'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { setBookingStatus, cancelBooking, requestBill } from '@/lib/actions/bookings'
import { formatMoney } from '@/lib/format'
import type { HappyHourRule } from '@/lib/happy-hours/apply'
import type { OrderSummary } from '@/components/bookings/BookingsView'
import type { TableStatus } from '@/lib/booking/table-status'

/** Poll for status changes from other terminals (another waiter, the kitchen,
 *  a QR bill request) — real-time push is a later milestone (AROS-96), same
 *  simplest-workable approach components/kitchen/KitchenQueue.tsx already
 *  uses for the same reason. */
const POLL_MS = 5000
/** How often the "seated Xm" label re-renders between polls. */
const CLOCK_MS = 15000

export type TableRow = {
  id: string
  name: string
  typeName: string
  color: string | null
  bookingId: string | null
  bookingNumber: string | null
  coverCount: number | null
  customerName: string | null
  customerPhone: string | null
  checkedInAt: string | null
  billRequestedAt: string | null
  status: TableStatus
  runningTotal: number
}

const STATUS_LABEL: Record<TableStatus, string> = {
  free: 'Free',
  seated: 'Seated',
  ordered: 'Ordered',
  served: 'Served',
  bill_requested: 'Bill requested',
  needs_cleaning: 'Needs cleaning',
}

const STATUS_BADGE: Record<TableStatus, string> = {
  free: 'bg-muted text-muted-foreground',
  seated: 'bg-blue-500/10 text-blue-600',
  ordered: 'bg-amber-500/10 text-amber-600',
  served: 'bg-emerald-500/10 text-emerald-600',
  bill_requested: 'bg-violet-500/10 text-violet-600',
  needs_cleaning: 'bg-rose-500/10 text-rose-600',
}

const STATUS_TILE: Record<TableStatus, string> = {
  free: 'border-dashed hover:bg-muted/40',
  seated: 'border-blue-500/40 bg-blue-500/5',
  ordered: 'border-amber-500/40 bg-amber-500/5',
  served: 'border-emerald-500/40 bg-emerald-500/5',
  bill_requested: 'border-violet-500/40 bg-violet-500/5',
  needs_cleaning: 'border-rose-500/40 bg-rose-500/5',
}

function elapsedLabel(since: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export function FloorView({
  branchId,
  currency,
  timeZone,
  tables,
  categories,
  menuItems,
  happyHours,
  ordersByBooking,
}: {
  branchId: string
  currency: string
  timeZone: string
  tables: TableRow[]
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
  ordersByBooking: Record<string, OrderSummary[]>
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [now, setNow] = useState(() => Date.now())
  const [seatTarget, setSeatTarget] = useState<TableRow | null>(null)
  const [selected, setSelected] = useState<TableRow | null>(null)
  const [orderDialog, setOrderDialog] = useState<{ bookingId: string; bookingLabel: string } | null>(null)
  const [pending, start] = useTransition()
  const [actingAction, setActingAction] = useState<string | null>(null)

  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [router])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  // The detail panel is keyed off `tables`, so a poll that changes the
  // selected table's status (another terminal took an order, the kitchen
  // marked it served) is reflected without the waiter having to reopen it.
  const liveSelected = selected ? (tables.find((t) => t.id === selected.id) ?? null) : null

  function act(action: string, fn: () => Promise<{ error?: string }>) {
    setActingAction(action)
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        setSelected(null)
        router.refresh()
      }
      setActingAction(null)
    })
  }

  async function handleCancel(table: TableRow) {
    if (!table.bookingId || !table.bookingNumber) return
    await confirm({
      title: `Cancel table session ${table.bookingNumber}?`,
      description: `This will free up ${table.name} without billing it. This cannot be undone.`,
      confirmText: 'Cancel session',
      cancelText: 'Keep session',
      onConfirm: async () => {
        const r = await cancelBooking(table.bookingId!)
        if (r.error) toast.error(r.error)
        else {
          setSelected(null)
          router.refresh()
          toast.success(`${table.name} freed up.`)
        }
      },
    })
  }

  const counts = tables.reduce<Record<TableStatus, number>>(
    (acc, t) => {
      acc[t.status]++
      return acc
    },
    { free: 0, seated: 0, ordered: 0, served: 0, bill_requested: 0, needs_cleaning: 0 },
  )

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Floor</h1>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {(Object.keys(STATUS_LABEL) as TableStatus[])
              .filter((s) => counts[s] > 0)
              .map((s) => (
                <span key={s}>
                  {counts[s]} {STATUS_LABEL[s].toLowerCase()}
                </span>
              ))}
          </p>
        </div>
      </div>

      {tables.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No tables set up yet. Add a resource type with no hourly rate (e.g. “Table”) in Settings → Resources, then
          add tables to it.
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {tables.map((t) => {
            const isOccupied = Boolean(t.bookingId)
            return (
              <button
                key={t.id}
                onClick={() => (isOccupied ? setSelected(t) : setSeatTarget(t))}
                className={`rounded-lg border p-3 text-left transition hover:shadow-sm ${STATUS_TILE[t.status]}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status]}`}>
                    {STATUS_LABEL[t.status]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t.typeName}</p>
                {isOccupied && (
                  <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Users size={13} />
                      {t.coverCount ?? '—'}
                      {t.customerName ? ` · ${t.customerName}` : ''}
                    </div>
                    {t.checkedInAt && (
                      <div className="flex items-center gap-1">
                        <Clock3 size={13} />
                        {elapsedLabel(t.checkedInAt, now)}
                      </div>
                    )}
                    {t.runningTotal > 0 && (
                      <div className="font-medium text-foreground">{formatMoney(t.runningTotal, currency)}</div>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      {seatTarget && (
        <SeatTableDialog
          branchId={branchId}
          tableId={seatTarget.id}
          tableName={seatTarget.name}
          onClose={() => setSeatTarget(null)}
          onSeated={(bookingId) => {
            setSeatTarget(null)
            router.refresh()
            toast.success(`${seatTarget.name} seated.`)
            setOrderDialog({ bookingId, bookingLabel: seatTarget.name })
          }}
        />
      )}

      {liveSelected && liveSelected.bookingId && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{liveSelected.name}</h2>
              <button
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>

            <span
              className={`mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[liveSelected.status]}`}
            >
              {STATUS_LABEL[liveSelected.status]}
            </span>

            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Booking</dt>
                <dd className="text-right font-medium">{liveSelected.bookingNumber}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Guests</dt>
                <dd className="text-right font-medium">{liveSelected.coverCount ?? '—'}</dd>
              </div>
              {liveSelected.customerName && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Customer</dt>
                  <dd className="text-right font-medium">{liveSelected.customerName}</dd>
                </div>
              )}
              {liveSelected.checkedInAt && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Seated</dt>
                  <dd className="text-right font-medium">{elapsedLabel(liveSelected.checkedInAt, now)} ago</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Running total</dt>
                <dd className="text-right font-medium">{formatMoney(liveSelected.runningTotal, currency)}</dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => setOrderDialog({ bookingId: liveSelected.bookingId!, bookingLabel: liveSelected.name })}
                disabled={menuItems.length === 0}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <Plus size={15} /> Take order
              </button>
              <Link
                href={`/pos/${liveSelected.bookingId}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                <ReceiptText size={15} /> Bill
              </Link>
              {!liveSelected.billRequestedAt && liveSelected.status !== 'needs_cleaning' && (
                <button
                  onClick={() => act('request_bill', () => requestBill(liveSelected.bookingId!))}
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
                >
                  {actingAction === 'request_bill' && <Loader2 size={14} className="animate-spin" />}
                  Request bill
                </button>
              )}
              <button
                onClick={() => act('complete', () => setBookingStatus(liveSelected.bookingId!, 'completed'))}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                {actingAction === 'complete' && <Loader2 size={14} className="animate-spin" />}
                {liveSelected.status === 'needs_cleaning' ? 'Table cleaned' : 'Mark table free'}
              </button>
              <button
                onClick={() => handleCancel(liveSelected)}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                Cancel session
              </button>
            </div>

            <div className="mt-4 border-t pt-3">
              <h3 className="text-sm font-semibold text-muted-foreground">Food orders</h3>
              {(ordersByBooking[liveSelected.bookingId] ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No food orders yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {(ordersByBooking[liveSelected.bookingId] ?? []).map((o) => (
                    <div key={o.orderId} className="rounded-md border p-2.5 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{o.orderNumber}</span>
                        <span className="text-xs capitalize text-muted-foreground">{o.status}</span>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {o.items.map((it) => (
                          <li key={it.itemId} className="flex justify-between gap-2 text-muted-foreground">
                            <span className="truncate">
                              {it.qty}× {it.itemName}
                            </span>
                            <span className="shrink-0 text-right">{formatMoney(Number(it.unitPrice) * it.qty, currency)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {orderDialog && (
        <TakeOrderDialog
          branchId={branchId}
          bookingId={orderDialog.bookingId}
          bookingLabel={orderDialog.bookingLabel}
          currency={currency}
          categories={categories}
          menuItems={menuItems}
          happyHours={happyHours}
          timeZone={timeZone}
          onClose={() => setOrderDialog(null)}
          onCreated={() => {
            setOrderDialog(null)
            router.refresh()
            toast.success('Order sent to the kitchen.')
          }}
        />
      )}
    </div>
  )
}
