'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, ReceiptText, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { SeatTableDialog } from './SeatTableDialog'
import { TakeOrderDialog, type CategoryOption, type MenuItemOption } from '@/components/orders/TakeOrderDialog'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { setBookingStatus, cancelBooking } from '@/lib/actions/bookings'
import { formatMoney } from '@/lib/format'
import type { HappyHourRule } from '@/lib/happy-hours/apply'
import type { OrderSummary } from '@/components/bookings/BookingsView'

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
}

export function TablesView({
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
  const [seatTarget, setSeatTarget] = useState<TableRow | null>(null)
  const [selected, setSelected] = useState<TableRow | null>(null)
  const [orderDialog, setOrderDialog] = useState<{ bookingId: string; bookingLabel: string } | null>(null)
  const [pending, start] = useTransition()
  const [actingAction, setActingAction] = useState<string | null>(null)

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

  const free = tables.filter((t) => !t.bookingId)
  const occupied = tables.filter((t) => t.bookingId)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tables</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {occupied.length} occupied · {free.length} free
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
                className={`rounded-lg border p-3 text-left transition hover:shadow-sm ${
                  isOccupied ? 'border-primary/50 bg-primary/5' : 'border-dashed hover:bg-muted/40'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      isOccupied ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isOccupied ? 'Occupied' : 'Free'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t.typeName}</p>
                {isOccupied && (
                  <div className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
                    <Users size={13} />
                    {t.coverCount ?? '—'}
                    {t.customerName ? ` · ${t.customerName}` : ''}
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

      {selected && selected.bookingId && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{selected.name}</h2>
              <button onClick={() => setSelected(null)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>

            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Booking</dt>
                <dd className="text-right font-medium">{selected.bookingNumber}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Guests</dt>
                <dd className="text-right font-medium">{selected.coverCount ?? '—'}</dd>
              </div>
              {selected.customerName && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Customer</dt>
                  <dd className="text-right font-medium">{selected.customerName}</dd>
                </div>
              )}
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => setOrderDialog({ bookingId: selected.bookingId!, bookingLabel: selected.name })}
                disabled={menuItems.length === 0}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <Plus size={15} /> Take order
              </button>
              <Link
                href={`/pos/${selected.bookingId}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                <ReceiptText size={15} /> Bill
              </Link>
              <button
                onClick={() => act('complete', () => setBookingStatus(selected.bookingId!, 'completed'))}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                {actingAction === 'complete' && <Loader2 size={14} className="animate-spin" />}
                Mark table free
              </button>
              <button
                onClick={() => handleCancel(selected)}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                Cancel session
              </button>
            </div>

            <div className="mt-4 border-t pt-3">
              <h3 className="text-sm font-semibold text-muted-foreground">Food orders</h3>
              {(ordersByBooking[selected.bookingId] ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No food orders yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {(ordersByBooking[selected.bookingId] ?? []).map((o) => (
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
