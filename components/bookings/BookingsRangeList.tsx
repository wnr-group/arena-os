'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { BookingDetailPanel, advanceGapOf, type OrderSummary, type PanelPaymentState } from './BookingDetailPanel'
import { PAYMENT_BADGE, PAYMENT_LABELS, SOURCE_BADGE, SOURCE_LABELS, STATUS_BADGE, STATUS_LABELS } from './bookingBadges'
import { dateInZone, formatMoney, prettyDate, timeInZone } from '@/lib/format'
import { groupByDay } from '@/lib/booking/range-groups'
import { todayInZone } from '@/lib/booking/time'
import { lateEntryLabel } from '@/lib/booking/late-entry'

/** One booking of the range, serialised (dates as ISO strings) by the page. */
export type RangeRow = {
  bookingId: string
  bookingNumber: string
  customerName: string | null
  customerPhone: string | null
  status: string
  source: string
  total: string
  deposit: string
  cancellationReason: string | null
  backdated: boolean
  bookingCreatedAt: string
  /** Earliest in-range slot start. */
  firstStartsAt: string
  lastEndsAt: string | null
  /** Some slot has no end yet (open-tab walk-in). */
  isOpen: boolean
  resourceNames: string[]
  /** Sum of slot_total over EVERY slot of the booking. */
  slotsTotal: string
  advancePaid: string
}

// Summary strip order; statuses not listed here (none today) are appended.
const STATUS_ORDER = ['pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']

/**
 * Multi-day bookings list (M34 #4): summary strip, rows grouped under tenant-tz
 * day headings (newest first), and the same detail panel the day timeline uses.
 * Rows come from one server query; after any panel action the panel calls
 * router.refresh() and the new props re-render the rows.
 */
export function BookingsRangeList({
  rows,
  fromDate,
  rangeLabel,
  summary,
  timeZone,
  currency,
  venueName,
  paymentStates,
  depositStates,
  ordersByBooking,
  canRequestVoidComp,
  canEditAddons,
  showFoodOrdering,
  footer,
}: {
  rows: RangeRow[]
  fromDate: string
  /** "11 Sep – 14 Oct 2026", for the empty state. */
  rangeLabel: string
  summary: { bookings: number; byStatus: Record<string, number> }
  timeZone: string
  currency: string
  venueName: string
  paymentStates: Record<string, PanelPaymentState>
  depositStates: Record<string, 'pending' | 'paid'>
  ordersByBooking: Record<string, OrderSummary[]>
  canRequestVoidComp: boolean
  canEditAddons: boolean
  showFoodOrdering: boolean
  /** Server-rendered pager. */
  footer?: ReactNode
}) {
  // Keyed by id, not a row snapshot, so the open panel follows a refresh.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const groups = useMemo(() => groupByDay(rows, fromDate, timeZone), [rows, fromDate, timeZone])
  const selectedRow = rows.find((r) => r.bookingId === selectedId) ?? null

  const statuses = [
    ...STATUS_ORDER.filter((s) => summary.byStatus[s]),
    ...Object.keys(summary.byStatus).filter((s) => !STATUS_ORDER.includes(s) && summary.byStatus[s]),
  ]

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2" aria-label="Range summary">
        <span className="mr-1 text-base font-semibold">
          {summary.bookings} {summary.bookings === 1 ? 'booking' : 'bookings'}
        </span>
        {statuses.map((s) => (
          <span
            key={s}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-medium ${STATUS_BADGE[s] ?? 'bg-muted text-muted-foreground'}`}
          >
            {STATUS_LABELS[s] ?? s}
            <span className="tabular-nums">{summary.byStatus[s]}</span>
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-lg border px-4 py-10 text-center text-base text-muted-foreground">
          No bookings between {rangeLabel}
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border">
          {groups.map((g) => (
            <section key={g.date} aria-label={prettyDate(g.date)}>
              <h2 className="border-b bg-muted/40 px-4 py-2 text-sm font-semibold text-muted-foreground">
                {prettyDate(g.date)}
              </h2>
              <ul className="divide-y divide-border">
                {g.rows.map((r) => (
                  <li key={r.bookingId}>
                    <BookingRow
                      row={r}
                      groupDate={g.date}
                      timeZone={timeZone}
                      currency={currency}
                      payment={paymentStates[r.bookingId]}
                      onOpen={() => setSelectedId(r.bookingId)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {footer}
        </div>
      )}

      <BookingDetailPanel
        booking={
          selectedRow && {
            bookingId: selectedRow.bookingId,
            bookingNumber: selectedRow.bookingNumber,
            customerName: selectedRow.customerName,
            customerPhone: selectedRow.customerPhone,
            status: selectedRow.status,
            source: selectedRow.source,
            total: selectedRow.total,
            deposit: selectedRow.deposit,
            advancePaid: selectedRow.advancePaid,
            bookingActiveSlotTotal: activeSlotTotal(selectedRow),
            startsAt: selectedRow.firstStartsAt,
            endsAt: selectedRow.isOpen ? null : selectedRow.lastEndsAt,
            cancellationReason: selectedRow.cancellationReason,
            backdated: selectedRow.backdated,
            bookingCreatedAt: selectedRow.bookingCreatedAt,
          }
        }
        timeZone={timeZone}
        currency={currency}
        venueName={venueName}
        depositStates={depositStates}
        paymentStates={paymentStates}
        ordersByBooking={ordersByBooking}
        canRequestVoidComp={canRequestVoidComp}
        canEditAddons={canEditAddons}
        showFoodOrdering={showFoodOrdering}
        onClose={() => setSelectedId(null)}
      />
    </div>
  )
}

/**
 * The day view's "active slot total": slots go inactive exactly when a booking
 * is cancelled / no-show (trg_bookings_sync_slots), so it is the all-slot sum
 * for every other status and zero for those two.
 */
function activeSlotTotal(r: RangeRow): string {
  return r.status === 'cancelled' || r.status === 'no_show' ? '0.00' : r.slotsTotal
}

function BookingRow({
  row: r,
  groupDate,
  timeZone,
  currency,
  payment,
  onOpen,
}: {
  row: RangeRow
  groupDate: string
  timeZone: string
  currency: string
  payment: PanelPaymentState | undefined
  onOpen: () => void
}) {
  const cancelled = r.status === 'cancelled'
  // Same signal as the day table: a live invoice wins; otherwise the cash
  // advance falling short of the known total reads "Part paid".
  const advanceGap = payment ? undefined : advanceGapOf({ advancePaid: r.advancePaid, bookingActiveSlotTotal: activeSlotTotal(r) })
  const payKey = payment?.status ?? (advanceGap ? 'partially_paid' : 'unbilled')
  const dueText =
    payment && payment.refunded > 0
      ? `${formatMoney(payment.refunded, currency)} refunded`
      : payment && payment.status !== 'paid'
        ? `${formatMoney(payment.balance, currency)} due`
        : advanceGap
          ? `${formatMoney(advanceGap, currency)} due (est.)`
          : null

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View booking ${r.bookingNumber}`}
      className="flex w-full flex-col gap-2 px-4 py-3 text-left transition hover:bg-muted/20 sm:grid sm:grid-cols-[8.5rem_minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4"
    >
      <div className="text-sm tabular-nums text-muted-foreground">
        <span className={cancelled ? 'line-through' : undefined}>{timeLabel(r, groupDate, timeZone)}</span>
        <span className="ml-2 font-medium text-foreground sm:ml-0 sm:block">{r.bookingNumber}</span>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className={`truncate font-medium ${cancelled ? 'text-muted-foreground line-through' : ''}`}>
            {r.customerName || 'Walk-in'}
          </p>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_BADGE[r.source] ?? 'bg-muted text-muted-foreground'}`}
          >
            {SOURCE_LABELS[r.source] ?? r.source}
          </span>
          {r.backdated && (
            <span
              title={lateEntryLabel(r.bookingCreatedAt, r.firstStartsAt, timeZone)}
              className="inline-flex items-center rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white"
            >
              Entered late
            </span>
          )}
        </div>
        {r.customerPhone && <p className="text-sm text-muted-foreground">{r.customerPhone}</p>}
        {cancelled && r.cancellationReason && (
          <p className="mt-0.5 text-sm text-destructive">Reason: {r.cancellationReason}</p>
        )}
      </div>

      <p className="min-w-0 break-words text-sm text-muted-foreground">{r.resourceNames.join(', ')}</p>

      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-start sm:gap-1">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${STATUS_BADGE[r.status] ?? 'bg-muted text-muted-foreground'}`}
        >
          {STATUS_LABELS[r.status] ?? r.status}
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${PAYMENT_BADGE[payKey]}`}
        >
          {PAYMENT_LABELS[payKey]}
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-end sm:justify-start sm:gap-0">
        {/* Once billed the invoice's total is the real figure; bookings.total
            stays 0.00 for a walk-in until checkout (same rule as the day table). */}
        <span className="font-medium tabular-nums">{formatMoney(payment?.total ?? Number(r.total), currency)}</span>
        {dueText && <span className="text-xs text-muted-foreground">{dueText}</span>}
      </div>
    </button>
  )
}

/**
 * "10:00–12:00", "open tab" when no end is set. Adds the date when the booking
 * began before the day it is listed under (carried in from before the range),
 * or ends on a later local day than it starts.
 */
function timeLabel(r: RangeRow, groupDate: string, tz: string): string {
  const startDay = todayInZone(tz, new Date(r.firstStartsAt))
  const start = `${startDay !== groupDate ? `${dateInZone(r.firstStartsAt, tz)} ` : ''}${timeInZone(r.firstStartsAt, tz)}`
  if (r.isOpen || !r.lastEndsAt) return `${start} · open tab`
  const endDay = todayInZone(tz, new Date(r.lastEndsAt))
  const end = `${endDay !== startDay ? `${dateInZone(r.lastEndsAt, tz)} ` : ''}${timeInZone(r.lastEndsAt, tz)}`
  return `${start}–${end}`
}
