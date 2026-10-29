'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { BookingDetailPanel, advanceGapOf, type OrderSummary, type PanelPaymentState } from './BookingDetailPanel'
import {
  PAYMENT_LABELS,
  REFUND_REQUIRED_BADGE,
  REFUND_REQUIRED_LABEL,
  SOURCE_BADGE,
  SOURCE_LABELS,
  STATUS_BADGE,
  STATUS_LABELS,
  statusText,
} from './bookingBadges'
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
  /** pending_payment only: when the payment hold lapses (ISO). */
  paymentHoldExpiresAt: string | null
  /** A paid online deposit on a cancelled booking is owed back. */
  depositReviewRequired: boolean
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
  /** Sum of slot_total over the booking's ACTIVE slots — the day view's bookingActiveSlotTotal. */
  activeSlotsTotal: string
  advancePaid: string
}

// Shared by the column header and every row so the columns line up.
const COLS = 'sm:grid-cols-[8rem_minmax(0,1.6fr)_minmax(0,1fr)_9.5rem_7.5rem]'

const STATUS_DOT: Record<string, string> = {
  pending_payment: 'bg-amber-500',
  confirmed: 'bg-blue-500',
  checked_in: 'bg-emerald-500',
  completed: 'bg-zinc-400',
  cancelled: 'bg-rose-500',
  no_show: 'bg-amber-500',
}
const PAYMENT_DOT: Record<string, string> = {
  paid: 'bg-emerald-500',
  partially_paid: 'bg-amber-500',
  issued: 'bg-rose-500',
  partially_refunded: 'bg-orange-500',
  refunded: 'bg-zinc-500',
  unbilled: 'bg-zinc-300 dark:bg-zinc-600',
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
  canReschedule = false,
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
  canReschedule?: boolean
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
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-label="Range summary">
        <div className="col-span-2 rounded-lg border bg-card px-4 py-2.5 sm:col-span-1 sm:min-w-[8.5rem]">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total</p>
          <p className="text-2xl font-semibold tabular-nums leading-tight">
            {summary.bookings}
            <span className="ml-1.5 text-sm font-medium text-muted-foreground">
              {summary.bookings === 1 ? 'booking' : 'bookings'}
            </span>
          </p>
        </div>
        {statuses.map((s) => (
          <div key={s} className="rounded-lg border bg-card px-4 py-2.5 sm:min-w-[7.5rem]">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s] ?? 'bg-zinc-400'}`} aria-hidden />
              {STATUS_LABELS[s] ?? s}
            </p>
            <p className="text-2xl font-semibold tabular-nums leading-tight">{summary.byStatus[s]}</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl border bg-card px-4 py-12 text-center text-base text-muted-foreground">
          No bookings between {rangeLabel}
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div
            className={`hidden gap-4 border-b bg-muted/50 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:grid ${COLS}`}
            aria-hidden
          >
            <span>Time</span>
            <span>Customer</span>
            <span>Resource</span>
            <span>Status</span>
            <span className="text-right">Amount</span>
          </div>
          {groups.map((g) => (
            <section key={g.date} aria-label={prettyDate(g.date)} className="border-b last:border-b-0">
              <h2 className="flex items-baseline justify-between gap-3 border-b bg-muted/30 px-5 py-2">
                <span className="text-sm font-semibold">{prettyDate(g.date)}</span>
                <span className="text-xs text-muted-foreground">
                  {g.rows.length} {g.rows.length === 1 ? 'booking' : 'bookings'}
                </span>
              </h2>
              <ul className="divide-y divide-border/70">
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
            bookingActiveSlotTotal: selectedRow.activeSlotsTotal,
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
        canReschedule={canReschedule}
        showFoodOrdering={showFoodOrdering}
        onClose={() => setSelectedId(null)}
      />
    </div>
  )
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
  const advanceGap = payment ? undefined : advanceGapOf({ advancePaid: r.advancePaid, bookingActiveSlotTotal: r.activeSlotsTotal })
  const payKey = payment?.status ?? (advanceGap ? 'partially_paid' : 'unbilled')
  const dueText =
    payment && payment.refunded > 0
      ? `${formatMoney(payment.refunded, currency)} refunded`
      : payment && payment.status !== 'paid'
        ? `${formatMoney(payment.balance, currency)} due`
        : advanceGap
          ? `${formatMoney(advanceGap, currency)} due (est.)`
          : null
  const time = timeParts(r, groupDate, timeZone)

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View booking ${r.bookingNumber}`}
      className={`grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:items-center ${COLS}`}
    >
      {/* Time + booking number */}
      <span className="order-1 block min-w-0 sm:order-none">
        <span className={`block text-sm font-semibold tabular-nums ${cancelled ? 'text-muted-foreground line-through' : ''}`}>
          {time.main}
        </span>
        {time.note && (
          <span className="mt-0.5 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600">
            {time.note}
          </span>
        )}
        <span className="mt-0.5 block text-xs text-muted-foreground">{r.bookingNumber}</span>
      </span>

      {/* Customer */}
      <span className="order-3 col-span-2 block min-w-0 sm:order-none sm:col-span-1">
        <span className={`block truncate text-[15px] font-semibold ${cancelled ? 'text-muted-foreground' : ''}`}>
          {r.customerName || 'Walk-in'}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${SOURCE_BADGE[r.source] ?? 'bg-muted text-muted-foreground'}`}
          >
            {SOURCE_LABELS[r.source] ?? r.source}
          </span>
          {r.customerPhone && <span className="tabular-nums">{r.customerPhone}</span>}
          {r.backdated && (
            <span
              title={lateEntryLabel(r.bookingCreatedAt, r.firstStartsAt, timeZone)}
              className="inline-flex items-center rounded bg-violet-600 px-1.5 py-0.5 text-[11px] font-medium text-white"
            >
              Entered late
            </span>
          )}
        </span>
        {cancelled && r.cancellationReason && (
          <span className="mt-1.5 block rounded-md bg-destructive/5 px-2 py-1 text-xs text-destructive">
            <span className="font-semibold">Reason:</span> {r.cancellationReason}
          </span>
        )}
      </span>

      {/* Resource */}
      <span className="order-4 col-span-2 block min-w-0 break-words text-sm text-muted-foreground sm:order-none sm:col-span-1">
        <span className="font-medium text-muted-foreground/70 sm:hidden">Resource · </span>
        {r.resourceNames.join(', ')}
      </span>

      {/* Status + payment */}
      <span className="order-5 col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:order-none sm:col-span-1 sm:flex-col sm:items-start sm:gap-1.5">
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[r.status] ?? 'bg-muted text-muted-foreground'}`}
        >
          {statusText(r.status, r.paymentHoldExpiresAt, timeZone)}
        </span>
        {r.depositReviewRequired && (
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${REFUND_REQUIRED_BADGE}`}>
            {REFUND_REQUIRED_LABEL}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${PAYMENT_DOT[payKey] ?? 'bg-zinc-300'}`} aria-hidden />
          {PAYMENT_LABELS[payKey]}
        </span>
      </span>

      {/* Amount. Once billed the invoice's total is the real figure;
          bookings.total stays 0.00 for a walk-in until checkout (same rule as the day table). */}
      <span className="order-2 block text-right sm:order-none">
        <span className={`block text-[15px] font-semibold tabular-nums ${cancelled ? 'text-muted-foreground' : ''}`}>
          {formatMoney(payment?.total ?? Number(r.total), currency)}
        </span>
        {dueText && <span className="mt-0.5 block text-xs font-medium text-amber-600">{dueText}</span>}
      </span>
    </button>
  )
}

/**
 * Time column: "10:00–12:00", or the start with an "Open tab" note when no end
 * is set. Adds the date when the booking began before the day it is listed
 * under (carried in from before the range), or ends on a later local day.
 */
function timeParts(r: RangeRow, groupDate: string, tz: string): { main: string; note: string | null } {
  const startDay = todayInZone(tz, new Date(r.firstStartsAt))
  const start = `${startDay !== groupDate ? `${dateInZone(r.firstStartsAt, tz)} ` : ''}${timeInZone(r.firstStartsAt, tz)}`
  if (r.isOpen || !r.lastEndsAt) return { main: start, note: 'Open tab' }
  const endDay = todayInZone(tz, new Date(r.lastEndsAt))
  const end = `${endDay !== startDay ? `${dateInZone(r.lastEndsAt, tz)} ` : ''}${timeInZone(r.lastEndsAt, tz)}`
  return { main: `${start}–${end}`, note: null }
}
