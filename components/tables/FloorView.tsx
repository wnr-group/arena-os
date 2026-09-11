'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, Ban, Clock3, Combine, Loader2, Plus, Receipt, ReceiptText, Split, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { SeatTableDialog } from './SeatTableDialog'
import { TransferTableDialog } from './TransferTableDialog'
import { MergeTablesDialog } from './MergeTablesDialog'
import { SplitTableDialog } from './SplitTableDialog'
import { TakeOrderDialog, type CategoryOption, type MenuItemOption } from '@/components/orders/TakeOrderDialog'
import { VoidCompDialog } from '@/components/orders/VoidCompDialog'
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
  bill_requested: 'bg-accent text-primary',
  needs_cleaning: 'bg-rose-500/10 text-rose-600',
}

const STATUS_TILE: Record<TableStatus, string> = {
  free: 'border-dashed border-border hover:border-primary/40 hover:bg-muted/30',
  seated: 'border-blue-500/30 bg-gradient-to-b from-blue-500/[0.07] to-transparent hover:border-blue-500/50',
  ordered: 'border-amber-500/30 bg-gradient-to-b from-amber-500/[0.07] to-transparent hover:border-amber-500/50',
  served: 'border-emerald-500/30 bg-gradient-to-b from-emerald-500/[0.07] to-transparent hover:border-emerald-500/50',
  bill_requested: 'border-primary/30 bg-gradient-to-b from-primary/[0.07] to-transparent hover:border-primary/50',
  needs_cleaning: 'border-rose-500/30 bg-gradient-to-b from-rose-500/[0.07] to-transparent hover:border-rose-500/50',
}

/** Solid accent used for the card's top bar and status-dot — one shade up
 *  from STATUS_BADGE's tinted background, for a stronger hover/at-a-glance
 *  read on the floor grid. Free carries no accent: an empty table needs no
 *  emphasis. */
const STATUS_ACCENT: Record<TableStatus, string> = {
  free: 'bg-transparent',
  seated: 'bg-blue-500',
  ordered: 'bg-amber-500',
  served: 'bg-emerald-500',
  bill_requested: 'bg-primary',
  needs_cleaning: 'bg-rose-500',
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
  popularItemIds,
  ordersByBooking,
  canRequestVoidComp,
  canToggle86,
}: {
  branchId: string
  currency: string
  timeZone: string
  tables: TableRow[]
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
  popularItemIds?: string[]
  ordersByBooking: Record<string, OrderSummary[]>
  /** Gates the void/comp button — a UI nicety only; requestVoidOrderItem
   *  re-checks the role server-side regardless (M17 #6). A manager/owner's
   *  request is applied immediately; anyone else's goes to the approval
   *  queue at /orders/void-requests. */
  canRequestVoidComp: boolean
  /** Gates the inline 86/un-86 toggle in TakeOrderDialog — a UI nicety only;
   *  setMenuItemAvailability re-checks canManageKitchen() server-side
   *  regardless (M17 #7). */
  canToggle86: boolean
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [now, setNow] = useState(() => Date.now())
  const [seatTarget, setSeatTarget] = useState<TableRow | null>(null)
  const [selected, setSelected] = useState<TableRow | null>(null)
  const [orderDialog, setOrderDialog] = useState<{ bookingId: string; bookingLabel: string } | null>(null)
  const [transferTarget, setTransferTarget] = useState<TableRow | null>(null)
  const [mergeTarget, setMergeTarget] = useState<TableRow | null>(null)
  const [splitTarget, setSplitTarget] = useState<TableRow | null>(null)
  const [voidTarget, setVoidTarget] = useState<{ itemId: string; itemName: string; qty: number } | null>(null)
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
  const freeTables = tables.filter((t) => !t.bookingId)

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
          <div className="mt-2.5 flex flex-wrap gap-2">
            {(Object.keys(STATUS_LABEL) as TableStatus[])
              .filter((s) => counts[s] > 0)
              .map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 py-1 pl-2.5 pr-3 text-xs font-medium text-muted-foreground shadow-sm"
                >
                  <span className={`size-1.5 rounded-full ${s === 'free' ? 'bg-muted-foreground/40' : STATUS_ACCENT[s]}`} />
                  <span className="font-semibold text-foreground tabular-nums">{counts[s]}</span>
                  {STATUS_LABEL[s].toLowerCase()}
                </span>
              ))}
          </div>
        </div>
      </div>

      {tables.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No tables set up yet. Add a resource type with no hourly rate (e.g. “Table”) in Settings → Resources, then
          add tables to it.
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4">
          {tables.map((t) => {
            const isOccupied = Boolean(t.bookingId)
            return (
              <button
                key={t.id}
                onClick={() => (isOccupied ? setSelected(t) : setSeatTarget(t))}
                className={`group relative overflow-hidden rounded-xl border p-4 text-left shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${STATUS_TILE[t.status]}`}
              >
                <span className={`absolute inset-x-0 top-0 h-1 opacity-80 transition-opacity duration-300 group-hover:opacity-100 ${STATUS_ACCENT[t.status]}`} />

                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold tracking-tight">{t.name}</span>
                  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[t.status]}`}>
                    {t.status !== 'free' && <span className={`size-1.5 rounded-full ${STATUS_ACCENT[t.status]}`} />}
                    {STATUS_LABEL[t.status]}
                  </span>
                </div>
                <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{t.typeName}</p>

                {isOccupied ? (
                  <div className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <Users size={13} className="shrink-0 text-muted-foreground/60" />
                      <span className="truncate">
                        {t.coverCount ?? '—'}
                        {t.customerName ? ` · ${t.customerName}` : ''}
                      </span>
                    </div>
                    {t.checkedInAt && (
                      <div className="flex items-center gap-1.5">
                        <Clock3 size={13} className="shrink-0 text-muted-foreground/60" />
                        <span>{elapsedLabel(t.checkedInAt, now)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <Plus size={13} /> Tap to seat
                  </div>
                )}

                {isOccupied && t.runningTotal > 0 && (
                  <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground/60">Running total</span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {formatMoney(t.runningTotal, currency)}
                    </span>
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
                href={`/tab/${liveSelected.bookingId}`}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <Receipt size={15} /> View tab
              </Link>
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
              {liveSelected.status !== 'needs_cleaning' && (
                <>
                  <button
                    onClick={() => setTransferTarget(liveSelected)}
                    disabled={pending || freeTables.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
                  >
                    <ArrowLeftRight size={15} /> Transfer
                  </button>
                  <button
                    onClick={() => setMergeTarget(liveSelected)}
                    disabled={pending || tables.filter((t) => t.bookingId && t.id !== liveSelected.id).length === 0}
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
                  >
                    <Combine size={15} /> Merge
                  </button>
                  <button
                    onClick={() => setSplitTarget(liveSelected)}
                    disabled={pending || freeTables.length === 0 || (liveSelected.coverCount ?? 0) < 2}
                    title={(liveSelected.coverCount ?? 0) < 2 ? 'Needs at least 2 guests to split' : undefined}
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
                  >
                    <Split size={15} /> Split
                  </button>
                </>
              )}
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
                          <li
                            key={it.itemId}
                            className={`flex justify-between gap-2 text-muted-foreground ${it.voidStatus !== 'active' ? 'opacity-50' : ''}`}
                          >
                            <span className="truncate">
                              <span className={it.voidStatus !== 'active' ? 'line-through' : undefined}>
                                {it.qty}× {it.itemName}
                              </span>
                              {it.modifiers.length > 0 && (
                                <span className="ml-1 text-xs text-primary">— {it.modifiers.join(', ')}</span>
                              )}
                              {it.voidStatus !== 'active' && (
                                <span
                                  className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                    it.voidStatus === 'comped'
                                      ? 'bg-accent text-primary'
                                      : 'bg-destructive/10 text-destructive'
                                  }`}
                                  title={it.voidReason ?? undefined}
                                >
                                  {it.voidStatus === 'comped' ? 'Comped' : 'Voided'}
                                </span>
                              )}
                              {it.voidStatus === 'active' && it.pendingVoidMode && (
                                <span
                                  className="ml-1.5 inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
                                  title="Awaiting manager approval"
                                >
                                  {it.pendingVoidMode === 'comp' ? 'Comp requested' : 'Void requested'}
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5 text-right">
                              <span className={it.voidStatus !== 'active' ? 'line-through' : undefined}>
                                {formatMoney(Number(it.unitPrice) * it.qty, currency)}
                              </span>
                              {canRequestVoidComp && it.voidStatus === 'active' && !it.pendingVoidMode && o.status === 'open' && (
                                <button
                                  type="button"
                                  onClick={() => setVoidTarget({ itemId: it.itemId, itemName: it.itemName, qty: it.qty })}
                                  title="Void or comp this item"
                                  className="rounded p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Ban size={13} />
                                </button>
                              )}
                            </span>
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

      {transferTarget && transferTarget.bookingId && (
        <TransferTableDialog
          bookingId={transferTarget.bookingId}
          sourceTableName={transferTarget.name}
          freeTables={freeTables}
          onClose={() => setTransferTarget(null)}
          onTransferred={(targetName) => {
            setTransferTarget(null)
            setSelected(null)
            router.refresh()
            toast.success(`${transferTarget.name} moved to ${targetName}.`)
          }}
        />
      )}

      {mergeTarget && mergeTarget.bookingId && (
        <MergeTablesDialog
          bookingId={mergeTarget.bookingId}
          sourceTableName={mergeTarget.name}
          otherOccupiedTables={tables
            .filter((t) => t.bookingId && t.id !== mergeTarget.id)
            .map((t) => ({ bookingId: t.bookingId!, name: t.name, coverCount: t.coverCount }))}
          onClose={() => setMergeTarget(null)}
          onMerged={(intoTableName) => {
            setMergeTarget(null)
            setSelected(null)
            router.refresh()
            toast.success(`${mergeTarget.name} merged into ${intoTableName}.`)
          }}
        />
      )}

      {splitTarget && splitTarget.bookingId && (
        <SplitTableDialog
          bookingId={splitTarget.bookingId}
          sourceTableName={splitTarget.name}
          sourceCoverCount={splitTarget.coverCount}
          openOrders={(ordersByBooking[splitTarget.bookingId] ?? []).filter((o) => o.status === 'open')}
          freeTables={freeTables}
          currency={currency}
          onClose={() => setSplitTarget(null)}
          onSplit={(_newBookingId, newBookingNumber, targetName) => {
            setSplitTarget(null)
            setSelected(null)
            router.refresh()
            toast.success(`Split off to ${targetName} as ${newBookingNumber}.`)
          }}
        />
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
          popularItemIds={popularItemIds}
          canToggle86={canToggle86}
          timeZone={timeZone}
          onClose={() => setOrderDialog(null)}
          onCreated={() => {
            setOrderDialog(null)
            router.refresh()
            toast.success('Order sent to the kitchen.')
          }}
        />
      )}

      {voidTarget && (
        <VoidCompDialog
          item={voidTarget}
          onClose={() => setVoidTarget(null)}
          onDone={(mode, status) => {
            setVoidTarget(null)
            router.refresh()
            if (status === 'pending') {
              toast.success('Sent for manager approval.')
            } else {
              toast.success(mode === 'comp' ? 'Item comped.' : 'Item voided.')
            }
          }}
        />
      )}
    </div>
  )
}
