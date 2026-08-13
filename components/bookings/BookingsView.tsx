'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  Search,
  ShoppingBag,
  UserCheck,
  ReceiptText,
  X,
} from 'lucide-react'
import { NewBookingDialog } from './NewBookingDialog'
import { TakeOrderDialog, type CategoryOption, type MenuItemOption } from '@/components/orders/TakeOrderDialog'
import { setBookingStatus, cancelBooking } from '@/lib/actions/bookings'
import { formatMoney, timeInZone, prettyDate } from '@/lib/format'
import type { HappyHourRule } from '@/lib/happy-hours/apply'

type Resource = { id: string; name: string; typeName: string; status: string }
type Slot = {
  slotId: string
  resourceId: string
  startsAt: string
  endsAt: string
  bookingId: string
  bookingNumber: string
  customerName: string | null
  customerPhone: string | null
  status: string
  source: string
  total: string
}
export type OrderItemLine = {
  itemId: string
  itemName: string
  unitPrice: string
  qty: number
  specialInstructions: string | null
  /** Set only when a happy-hour rule discounted this line at order time. */
  happyHourName: string | null
  originalUnitPrice: string | null
  happyHourDiscountType: 'percentage' | 'fixed' | null
  happyHourDiscountValue: string | null
}
export type OrderSummary = { orderId: string; orderNumber: string; status: string; items: OrderItemLine[] }

const STATUS_STYLE: Record<string, string> = {
  confirmed: 'bg-blue-500/85 text-white',
  checked_in: 'bg-emerald-500/85 text-white',
  completed: 'bg-zinc-400/80 text-white',
}
const STATUS_BADGE: Record<string, string> = {
  confirmed: 'bg-blue-500/10 text-blue-600',
  checked_in: 'bg-emerald-500/10 text-emerald-600',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  no_show: 'bg-amber-500/10 text-amber-600',
}
const STATUS_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}
type View = 'timeline' | 'bookings'

function minutesInZone(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso))
  const map: Record<string, number> = {}
  for (const p of parts) if (p.type !== 'literal') map[p.type] = Number(p.value)
  const h = map.hour === 24 ? 0 : map.hour
  return h * 60 + map.minute
}

export function BookingsView({
  branchId,
  branchName,
  timeZone,
  currency,
  date,
  prevDate,
  nextDate,
  today,
  closed,
  openMin,
  closeMin,
  resources,
  slots,
  categories,
  menuItems,
  happyHours,
  ordersByBooking,
}: {
  branchId: string
  branchName: string
  timeZone: string
  currency: string
  date: string
  prevDate: string
  nextDate: string
  today: string
  closed: boolean
  openMin: number
  closeMin: number
  resources: Resource[]
  slots: Slot[]
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
  ordersByBooking: Record<string, OrderSummary[]>
}) {
  const router = useRouter()
  const [view, setView] = useState<View>('timeline')
  const [showNew, setShowNew] = useState(false)
  const [presetResource, setPresetResource] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<Slot | null>(null)
  const [orderDialog, setOrderDialog] = useState<{ bookingId?: string; bookingLabel?: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all')
  const [pending, start] = useTransition()

  // One row per booking (a booking can span multiple resource slots).
  const bookingsList = useMemo(() => {
    const byId = new Map<
      string,
      {
        bookingId: string
        bookingNumber: string
        customerName: string | null
        customerPhone: string | null
        status: string
        source: string
        total: string
        resourceNames: string[]
        startsAt: string
        endsAt: string
        representative: Slot
      }
    >()
    for (const s of slots) {
      const resourceName = resources.find((r) => r.id === s.resourceId)?.name ?? ''
      const existing = byId.get(s.bookingId)
      if (!existing) {
        byId.set(s.bookingId, {
          bookingId: s.bookingId,
          bookingNumber: s.bookingNumber,
          customerName: s.customerName,
          customerPhone: s.customerPhone,
          status: s.status,
          source: s.source,
          total: s.total,
          resourceNames: [resourceName],
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          representative: s,
        })
      } else {
        if (resourceName) existing.resourceNames.push(resourceName)
        if (s.startsAt < existing.startsAt) existing.startsAt = s.startsAt
        if (s.endsAt > existing.endsAt) existing.endsAt = s.endsAt
      }
    }
    return [...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }, [slots, resources])

  const bookingStats = useMemo(() => {
    const total = bookingsList.length
    const confirmed = bookingsList.filter((b) => b.status === 'confirmed').length
    const checkedIn = bookingsList.filter((b) => b.status === 'checked_in').length
    const completed = bookingsList.filter((b) => b.status === 'completed').length
    return { total, confirmed, checkedIn, completed }
  }, [bookingsList])

  const filteredBookings = useMemo(() => {
    const q = search.trim().toLowerCase()
    return bookingsList.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false
      if (q) {
        const haystack = `${b.bookingNumber} ${b.customerName ?? ''} ${b.customerPhone ?? ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [bookingsList, search, statusFilter])

  const span = Math.max(60, closeMin - openMin)
  const pct = (min: number) => ((clamp(min) - openMin) / span) * 100
  function clamp(min: number) {
    return Math.min(closeMin, Math.max(openMin, min))
  }

  const firstHour = Math.floor(openMin / 60)
  const lastHour = Math.ceil(closeMin / 60)
  const hourTicks: number[] = []
  for (let h = firstHour; h <= lastHour; h++) hourTicks.push(h)

  function act(fn: () => Promise<{ error?: string }>) {
    start(async () => {
      const r = await fn()
      if (r.error) setToast(r.error)
      else {
        setSelected(null)
        router.refresh()
      }
    })
  }

  function openNew(resourceId?: string) {
    setPresetResource(resourceId)
    setShowNew(true)
  }

  return (
    <div className="px-6 py-6">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bookings</h1>
          <p className="text-sm text-muted-foreground">
            {branchName} · {prettyDate(date, timeZone)}
            {date === today && ' · Today'}
            {closed && ' · Closed'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/bookings?date=${prevDate}`} className="rounded-md border p-2 hover:bg-muted" aria-label="Previous day">
            <ChevronLeft size={16} />
          </Link>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && router.push(`/bookings?date=${e.target.value}`)}
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Link href={`/bookings?date=${nextDate}`} className="rounded-md border p-2 hover:bg-muted" aria-label="Next day">
            <ChevronRight size={16} />
          </Link>
          <button
            onClick={() => openNew()}
            disabled={resources.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={16} /> New booking
          </button>
          <button
            onClick={() => setOrderDialog({})}
            disabled={menuItems.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
          >
            <ShoppingBag size={16} /> Take order
          </button>
        </div>
      </div>

      {toast && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {toast}
        </p>
      )}

      {/* view tabs */}
      <div className="mt-5 flex gap-5 border-b border-border">
        <ViewTab active={view === 'timeline'} onClick={() => setView('timeline')}>
          Timeline
        </ViewTab>
        <ViewTab active={view === 'bookings'} onClick={() => setView('bookings')}>
          Bookings
        </ViewTab>
      </div>

      {/* timeline board */}
      {view === 'timeline' && (resources.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No bookable resources yet.{' '}
            <Link href="/settings/resources" className="font-medium text-foreground underline">
              Add resources
            </Link>{' '}
            to start taking bookings.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <div className="min-w-[680px]">
            {/* time axis */}
            <div className="flex">
              <div className="w-36 shrink-0" />
              <div className="relative h-6 flex-1">
                {hourTicks.map((h) => (
                  <span
                    key={h}
                    className="absolute -translate-x-1/2 text-xs text-muted-foreground"
                    style={{ left: `${pct(h * 60)}%` }}
                  >
                    {String(h).padStart(2, '0')}:00
                  </span>
                ))}
              </div>
            </div>

            {/* resource rows */}
            {resources.map((r) => {
              const rowSlots = slots.filter((s) => s.resourceId === r.id)
              return (
                <div key={r.id} className="flex items-stretch border-t">
                  <div className="w-36 shrink-0 py-3 pr-3">
                    <p className="truncate text-sm font-medium">{r.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.typeName}</p>
                  </div>
                  <button
                    className="relative h-16 flex-1 cursor-copy"
                    onClick={() => openNew(r.id)}
                    title="Click to add a booking on this resource"
                  >
                    {/* hour gridlines */}
                    {hourTicks.map((h) => (
                      <span
                        key={h}
                        className="absolute inset-y-0 w-px bg-border"
                        style={{ left: `${pct(h * 60)}%` }}
                      />
                    ))}
                    {rowSlots.map((s) => {
                      const left = pct(minutesInZone(s.startsAt, timeZone))
                      const right = pct(minutesInZone(s.endsAt, timeZone) || closeMin)
                      const width = Math.max(2, right - left)
                      return (
                        <span
                          key={s.slotId}
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelected(s)
                          }}
                          className={`absolute inset-y-2 overflow-hidden rounded-md px-2 py-1 text-left text-xs shadow-sm ${
                            STATUS_STYLE[s.status] ?? 'bg-zinc-500 text-white'
                          }`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        >
                          <span className="block truncate font-medium">
                            {s.customerName || 'Walk-in'}
                          </span>
                          <span className="block truncate opacity-90">
                            {timeInZone(s.startsAt, timeZone)}–{timeInZone(s.endsAt, timeZone)}
                          </span>
                        </span>
                      )
                    })}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* bookings list */}
      {view === 'bookings' && (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard icon={CalendarDays} label="Total bookings" value={bookingStats.total} accent="bg-primary/10 text-primary" />
            <StatCard icon={Clock} label="Confirmed" value={bookingStats.confirmed} accent="bg-blue-500/10 text-blue-600" />
            <StatCard icon={UserCheck} label="Checked in" value={bookingStats.checkedIn} accent="bg-emerald-500/10 text-emerald-600" />
            <StatCard icon={CheckCircle2} label="Completed" value={bookingStats.completed} accent="bg-muted text-muted-foreground" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
              <input
                className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                placeholder="Search by booking #, customer or phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => openNew()}
              disabled={resources.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2.5 text-base font-medium transition hover:bg-muted disabled:opacity-50"
            >
              <Plus size={16} /> Walk-in booking
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <StatusPill active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
              All
            </StatusPill>
            {(['confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'] as const).map((s) => (
              <StatusPill key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
                {STATUS_LABELS[s]}
              </StatusPill>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-base">
                <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Booking</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Resources</th>
                    <th className="px-4 py-3 font-medium">Time</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Total</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredBookings.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-base text-muted-foreground">
                        {bookingsList.length === 0 ? 'No bookings for this day.' : 'No bookings match your filters.'}
                      </td>
                    </tr>
                  )}
                  {filteredBookings.map((b) => (
                    <tr key={b.bookingId} className="transition hover:bg-muted/20">
                      <td className="px-4 py-3 font-medium">{b.bookingNumber}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{b.customerName || 'Walk-in'}</p>
                        {b.customerPhone && <p className="text-sm text-muted-foreground">{b.customerPhone}</p>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{b.resourceNames.join(', ')}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {timeInZone(b.startsAt, timeZone)}–{timeInZone(b.endsAt, timeZone)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${
                            STATUS_BADGE[b.status] ?? 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {STATUS_LABELS[b.status] ?? b.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatMoney(b.total, currency)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <button
                            onClick={() => setSelected(b.representative)}
                            className="rounded-lg px-3 py-1.5 text-sm font-medium text-primary hover:underline"
                          >
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* new booking dialog */}
      {showNew && (
        <NewBookingDialog
          branchId={branchId}
          date={date}
          timeZone={timeZone}
          resources={resources.map((r) => ({ id: r.id, name: r.name, typeName: r.typeName }))}
          presetResourceId={presetResource}
          onClose={() => setShowNew(false)}
          onCreated={(num) => {
            setShowNew(false)
            setToast(`Booking ${num} created.`)
            router.refresh()
          }}
        />
      )}

      {/* booking detail */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{selected.bookingNumber}</h2>
              <button onClick={() => setSelected(null)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row k="Customer" v={selected.customerName || 'Walk-in'} />
              {selected.customerPhone && <Row k="Phone" v={selected.customerPhone} />}
              <Row k="Time" v={`${timeInZone(selected.startsAt, timeZone)}–${timeInZone(selected.endsAt, timeZone)}`} />
              <Row k="Status" v={selected.status.replace('_', ' ')} />
              <Row k="Total" v={formatMoney(selected.total, currency)} />
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              {/* Only the statuses lib/billing/invoice.ts will actually bill.
                  The action re-checks — hiding a link is not authorization. */}
              {(selected.status === 'confirmed' || selected.status === 'checked_in') && (
                <Link
                  href={`/pos/${selected.bookingId}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  <ReceiptText size={15} /> Bill
                </Link>
              )}
              {selected.status === 'confirmed' && (
                <ActBtn label="Check in" onClick={() => act(() => setBookingStatus(selected.bookingId, 'checked_in'))} pending={pending} />
              )}
              {(selected.status === 'confirmed' || selected.status === 'checked_in') && (
                <ActBtn label="Complete" onClick={() => act(() => setBookingStatus(selected.bookingId, 'completed'))} pending={pending} />
              )}
              {selected.status === 'confirmed' && (
                <ActBtn label="No-show" variant="muted" onClick={() => act(() => setBookingStatus(selected.bookingId, 'no_show'))} pending={pending} />
              )}
              {selected.status !== 'completed' && (
                <ActBtn label="Cancel" variant="danger" onClick={() => act(() => cancelBooking(selected.bookingId))} pending={pending} />
              )}
            </div>

            <div className="mt-4 border-t pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Food orders</h3>
                <button
                  onClick={() =>
                    setOrderDialog({ bookingId: selected.bookingId, bookingLabel: selected.bookingNumber })
                  }
                  disabled={menuItems.length === 0}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:opacity-50"
                >
                  <Plus size={14} /> Add order
                </button>
              </div>
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
                              {it.specialInstructions ? ` — ${it.specialInstructions}` : ''}
                              {it.happyHourName && (
                                <span className="ml-1.5 inline-flex items-center rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                                  {it.happyHourName}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-right">
                              {it.originalUnitPrice && Number(it.originalUnitPrice) !== Number(it.unitPrice) && (
                                <span className="mr-1.5 line-through opacity-60">
                                  {formatMoney(Number(it.originalUnitPrice) * it.qty, currency)}
                                </span>
                              )}
                              {formatMoney(Number(it.unitPrice) * it.qty, currency)}
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

      {/* take order (walk-in or attached to the selected booking) */}
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
          onCreated={(num) => {
            setOrderDialog(null)
            setToast(`Order ${num} created.`)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative pb-3 text-sm font-medium transition ${
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
      <span className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full transition ${active ? 'bg-primary' : 'bg-transparent'}`} />
    </button>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string | number
  accent: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function StatusPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium capitalize">{v}</dd>
    </div>
  )
}

function ActBtn({
  label,
  onClick,
  pending,
  variant = 'primary',
}: {
  label: string
  onClick: () => void
  pending: boolean
  variant?: 'primary' | 'danger' | 'muted'
}) {
  const cls =
    variant === 'danger'
      ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
      : variant === 'muted'
        ? 'border hover:bg-muted'
        : 'bg-primary text-primary-foreground hover:opacity-90'
  return (
    <button onClick={onClick} disabled={pending} className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${cls}`}>
      {label}
    </button>
  )
}
