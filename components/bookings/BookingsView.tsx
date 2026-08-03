'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { NewBookingDialog } from './NewBookingDialog'
import { setBookingStatus, cancelBooking } from '@/lib/actions/bookings'
import { formatMoney, timeInZone, prettyDate } from '@/lib/format'

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

const STATUS_STYLE: Record<string, string> = {
  confirmed: 'bg-blue-500/85 text-white',
  checked_in: 'bg-emerald-500/85 text-white',
  completed: 'bg-zinc-400/80 text-white',
}

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
}) {
  const router = useRouter()
  const [showNew, setShowNew] = useState(false)
  const [presetResource, setPresetResource] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<Slot | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pending, start] = useTransition()

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
        </div>
      </div>

      {toast && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {toast}
        </p>
      )}

      {/* board */}
      {resources.length === 0 ? (
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
          <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}
    </div>
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
