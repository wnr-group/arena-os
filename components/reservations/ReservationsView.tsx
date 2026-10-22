'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CalendarPlus, ChevronLeft, ChevronRight, Phone, Settings2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { cancelReservation, markReservationNoShow } from '@/lib/actions/reservations'
import { reservationDisplayState, type ReservationStatusLabel } from '@/lib/reservations/rules'
import { NewReservationDialog } from './NewReservationDialog'
import { SeatReservationDialog, type SeatableTable } from './SeatReservationDialog'

const POLL_MS = 15000

export type ReservationItem = {
  bookingId: string
  bookingNumber: string
  status: string
  customerName: string | null
  customerPhone: string | null
  partySize: number | null
  /** ISO */
  reservedFor: string
  reservedMinutes: number | null
  tableId: string | null
  tableName: string | null
  seatedTableId: string | null
  source: string
  notes: string | null
}

const STATE_LABEL: Record<ReservationStatusLabel, string> = {
  upcoming: 'Upcoming',
  due: 'Arriving',
  late: 'Late',
  seated: 'Seated',
  no_show: 'No-show',
  cancelled: 'Cancelled',
  completed: 'Completed',
}

const STATE_BADGE: Record<ReservationStatusLabel, string> = {
  upcoming: 'bg-blue-500/10 text-blue-600',
  due: 'bg-emerald-500/10 text-emerald-600',
  late: 'bg-amber-500/10 text-amber-600',
  seated: 'bg-primary/10 text-primary',
  no_show: 'bg-rose-500/10 text-rose-600',
  cancelled: 'bg-muted text-muted-foreground',
  completed: 'bg-muted text-muted-foreground',
}

function timeLabel(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}

function dateTitle(dateStr: string, today: string) {
  if (dateStr === today) return 'Today'
  const d = new Date(`${dateStr}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' }).format(d)
}

function shift(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function ReservationsView({
  branchId,
  timeZone,
  date,
  today,
  graceMinutes,
  reservations,
  tables,
  isManager,
}: {
  branchId: string
  timeZone: string
  date: string
  today: string
  graceMinutes: number
  reservations: ReservationItem[]
  tables: SeatableTable[]
  isManager: boolean
}) {
  const router = useRouter()
  const [now, setNow] = useState(() => Date.now())
  const [creating, setCreating] = useState(false)
  const [seating, setSeating] = useState<ReservationItem | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
      router.refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [router])

  function act(fn: () => Promise<{ error?: string }>, done?: string) {
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        if (done) toast.success(done)
        router.refresh()
      }
    })
  }

  function cancel(r: ReservationItem) {
    const reason = window.prompt(`Cancel ${r.customerName ?? 'this'} reservation? Reason:`, 'Guest cancelled')
    if (reason === null) return
    act(() => cancelReservation({ bookingId: r.bookingId, reason: reason.trim() || 'Guest cancelled' }), 'Reservation cancelled.')
  }

  const rows = reservations.map((r) => ({
    r,
    state: reservationDisplayState(
      { status: r.status, resourceId: r.seatedTableId, reservedFor: new Date(r.reservedFor) },
      graceMinutes,
      new Date(now),
    ),
  }))
  const upcomingCount = rows.filter((x) => x.state === 'upcoming' || x.state === 'due' || x.state === 'late').length
  const coversExpected = rows
    .filter((x) => x.state === 'upcoming' || x.state === 'due' || x.state === 'late')
    .reduce((n, x) => n + (x.r.partySize ?? 0), 0)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reservations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {upcomingCount} to come · {coversExpected} guests expected
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isManager && (
            <Link
              href="/settings/reservations"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <Settings2 size={15} /> Settings
            </Link>
          )}
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <CalendarPlus size={15} /> New reservation
          </button>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Link href={`/reservations?date=${shift(date, -1)}`} aria-label="Previous day" className="rounded-md border border-border p-2 hover:bg-muted">
          <ChevronLeft size={16} />
        </Link>
        <span className="min-w-36 text-center text-base font-semibold">{dateTitle(date, today)}</span>
        <Link href={`/reservations?date=${shift(date, 1)}`} aria-label="Next day" className="rounded-md border border-border p-2 hover:bg-muted">
          <ChevronRight size={16} />
        </Link>
        {date !== today && (
          <Link href="/reservations" className="ml-1 text-sm font-medium text-primary hover:underline">
            Back to today
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No reservations for this day.
        </div>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {rows.map(({ r, state }) => {
            const canSeat = state === 'upcoming' || state === 'due' || state === 'late' || state === 'no_show'
            const canNoShow = state === 'upcoming' || state === 'due' || state === 'late'
            const canCancel = canSeat
            return (
              <li key={r.bookingId} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="w-16 text-lg font-semibold tabular-nums">{timeLabel(r.reservedFor, timeZone)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{r.customerName ?? 'Guest'}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>
                    {r.source === 'online' && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Online</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Users size={13} /> {r.partySize ?? '—'}
                    </span>
                    {r.tableName && <span>{r.tableName}</span>}
                    {r.customerPhone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone size={12} /> {r.customerPhone}
                      </span>
                    )}
                    <span className="text-xs">{r.bookingNumber}</span>
                  </div>
                  {r.notes && <p className="mt-1 text-sm text-muted-foreground">“{r.notes}”</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canSeat && (
                    <button
                      onClick={() => setSeating(r)}
                      disabled={pending}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {state === 'no_show' ? 'Seat (late)' : 'Seat'}
                    </button>
                  )}
                  {canNoShow && (
                    <button
                      onClick={() => act(() => markReservationNoShow(r.bookingId), 'Marked no-show.')}
                      disabled={pending}
                      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                    >
                      No-show
                    </button>
                  )}
                  {canCancel && (
                    <button
                      onClick={() => cancel(r)}
                      disabled={pending}
                      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {creating && (
        <NewReservationDialog
          branchId={branchId}
          initialDate={date < today ? today : date}
          minDate={today}
          onClose={() => setCreating(false)}
          onCreated={(n) => {
            setCreating(false)
            toast.success(`Reserved${n ? ` (${n})` : ''}.`)
            router.refresh()
          }}
        />
      )}

      {seating && (
        <SeatReservationDialog
          bookingId={seating.bookingId}
          guestName={seating.customerName ?? 'party'}
          reservedTableId={seating.tableId}
          partySize={seating.partySize ?? 2}
          tables={tables}
          onClose={() => setSeating(null)}
          onSeated={(tableName) => {
            setSeating(null)
            toast.success(`${tableName} seated.`)
            router.push('/floor')
          }}
        />
      )}
    </div>
  )
}
