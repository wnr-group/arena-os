'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { ArrowRight, CalendarDays, ChevronLeft, Loader2, Minus, Plus, X } from 'lucide-react'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import {
  getRescheduleContext,
  quoteReschedule,
  rescheduleBooking,
  type RescheduleContext,
  type RescheduleQuote,
} from '@/lib/actions/bookings'
import { getAvailableStarts } from '@/lib/actions/availability'
import { buildDurations } from '@/lib/booking/settings'
import { lastBookableDate } from '@/lib/booking/horizon'
import { todayInZone } from '@/lib/booking/time'
import { dateInZone, formatMoney, timeInZone } from '@/lib/format'

const MIN = 60_000

/**
 * Move a booking to a new date / time (confirmed) or change when it ends
 * (checked in). The server decides eligibility, re-validates the window and
 * re-prices; this dialog only offers times from the same availability the
 * booking wizard uses - with this booking's own slot left out, so its current
 * time reads as free - and shows the price change before anything is saved.
 */
export function RescheduleBookingDialog({
  bookingId,
  currency,
  onClose,
  onDone,
}: {
  bookingId: string
  currency: string
  onClose: () => void
  onDone: (newTotal: string | undefined) => void
}) {
  useBodyScrollLock()
  const [ctx, setCtx] = useState<RescheduleContext | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getRescheduleContext(bookingId).then((r) => {
      if (!alive) return
      if (r.error) setLoadError(r.error)
      else setCtx(r)
    })
    return () => {
      alive = false
    }
  }, [bookingId])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-border/60 bg-card shadow-[0_24px_80px_-12px_rgba(0,0,0,0.55)] sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-primary/15 to-transparent" />
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3.5 top-3.5 z-10 rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>
        {loadError ? (
          <div className="relative p-6">
            <h2 className="text-lg font-semibold tracking-tight">Can&apos;t reschedule</h2>
            <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
            <div className="mt-5 flex justify-end">
              <button className="rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-muted" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : !ctx ? (
          <div className="relative flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : (
          <RescheduleForm ctx={ctx} currency={currency} onClose={onClose} onDone={onDone} />
        )}
      </div>
    </div>
  )
}

function RescheduleForm({
  ctx,
  currency,
  onClose,
  onDone,
}: {
  ctx: RescheduleContext
  currency: string
  onClose: () => void
  onDone: (newTotal: string | undefined) => void
}) {
  const tz = ctx.timeZone!
  const step = ctx.slotMinutes ?? 30
  const endOnly = ctx.status === 'checked_in'
  const oldStart = ctx.startsAt!
  const oldDuration = Math.round((new Date(ctx.endsAt!).getTime() - new Date(oldStart).getTime()) / MIN)

  // The booking's current length may predate a step change; keep it selectable.
  const durations = useMemo(() => {
    const list = buildDurations(step)
    return list.includes(oldDuration) ? list : [...list, oldDuration].sort((a, b) => a - b)
  }, [step, oldDuration])

  const [date, setDate] = useState(() => todayInZone(tz, new Date(oldStart)))
  const [duration, setDuration] = useState(oldDuration)
  const [startsAt, setStartsAt] = useState<string | null>(endOnly ? oldStart : null)
  const [slots, setSlots] = useState<{ all: string[]; free: Set<string> } | null>(null)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [quote, setQuote] = useState<RescheduleQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startSave] = useTransition()

  const endsAt = startsAt ? new Date(new Date(startsAt).getTime() + duration * MIN).toISOString() : null
  const lastDate = lastBookableDate(ctx.today!, ctx.maxAdvanceDays!)

  // Start times for the chosen date + length (not needed once the booking has started).
  useEffect(() => {
    if (endOnly) return
    let alive = true
    setSlots(null)
    setSlotsError(null)
    getAvailableStarts({
      branchId: ctx.branchId!,
      resourceId: ctx.resourceId!,
      date,
      durationMinutes: duration,
      excludeBookingId: ctx.bookingId!,
    }).then((r) => {
      if (!alive) return
      if (r.error) setSlotsError(r.error)
      else setSlots({ all: r.allStarts ?? [], free: new Set(r.starts ?? []) })
    })
    return () => {
      alive = false
    }
  }, [endOnly, ctx.branchId, ctx.resourceId, ctx.bookingId, date, duration])

  // A picked start that the new date/length no longer offers is dropped.
  useEffect(() => {
    if (endOnly || !startsAt || !slots) return
    if (!slots.free.has(startsAt)) setStartsAt(null)
  }, [endOnly, slots, startsAt])

  const unchanged = startsAt === oldStart && duration === oldDuration

  // Live price check for the selected window.
  useEffect(() => {
    setQuote(null)
    setError(null)
    if (!startsAt || !endsAt || unchanged) return
    let alive = true
    setQuoting(true)
    quoteReschedule({ bookingId: ctx.bookingId!, startsAt, endsAt, expectedStartsAt: oldStart }).then((r) => {
      if (!alive) return
      setQuoting(false)
      if (r.error) setError(r.error)
      else setQuote(r)
    })
    return () => {
      alive = false
    }
  }, [ctx.bookingId, startsAt, endsAt, oldStart, unchanged])

  function save() {
    if (!startsAt || !endsAt) return
    setError(null)
    startSave(async () => {
      const r = await rescheduleBooking({
        bookingId: ctx.bookingId!,
        startsAt,
        endsAt,
        expectedStartsAt: oldStart,
        reason: reason.trim(),
      })
      if (r.error) setError(r.error)
      else onDone(r.newTotal)
    })
  }

  const diff = quote?.difference ? Number(quote.difference) : 0
  const canSave = !!startsAt && !!endsAt && !unchanged && !!quote && !quoting && !pending && reason.trim().length > 0

  const durIdx = durations.indexOf(duration)
  const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`)
  const label = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'
  const stepBtn =
    'flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background transition hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <>
      <div className="relative px-6 pb-4 pt-6">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className="-ml-1.5 inline-flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <ChevronLeft size={14} /> Back to booking
        </button>
        <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-primary">Reschedule</p>
        <h2 className="mt-0.5 text-xl font-semibold tracking-tight">{ctx.bookingNumber}</h2>
        <div className="mt-3 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-sm">
          {ctx.resourceName && <span className="font-medium">{ctx.resourceName}</span>}
          <span className="text-muted-foreground">
            {ctx.resourceName && '· '}
            {dateInZone(oldStart, tz)}, {timeInZone(oldStart, tz)}–{timeInZone(ctx.endsAt!, tz)}
          </span>
        </div>
        {endOnly && <p className="mt-2 text-xs text-amber-600">Already started, so only the duration can change.</p>}
      </div>

      <div className="relative min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-4">
        {!endOnly && (
          <div>
            <p className={label}>Date</p>
            <div className="relative mt-1.5">
              <CalendarDays size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="date"
                value={date}
                min={ctx.today}
                max={lastDate}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
        )}

        <div>
          <p className={label}>{endOnly ? 'Total duration' : 'Duration'}</p>
          <div className="mt-1.5 flex items-center gap-3">
            <button type="button" aria-label="Shorter" className={stepBtn} disabled={durIdx <= 0} onClick={() => setDuration(durations[durIdx - 1])}>
              <Minus size={16} />
            </button>
            <div className="flex-1 rounded-xl border border-border bg-background py-2 text-center">
              <p className="text-lg font-semibold tabular-nums leading-tight">{fmtDur(duration)}</p>
              {startsAt && endsAt && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {timeInZone(startsAt, tz)} – {timeInZone(endsAt, tz)}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Longer"
              className={stepBtn}
              disabled={durIdx < 0 || durIdx >= durations.length - 1}
              onClick={() => setDuration(durations[durIdx + 1])}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        {!endOnly && (
          <div>
            <p className={label}>Start time</p>
            {slotsError ? (
              <p className="mt-1.5 text-sm text-destructive">{slotsError}</p>
            ) : !slots ? (
              <div className="mt-1.5" aria-busy="true">
                <div className="grid grid-cols-4 gap-1.5">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-[38px] animate-pulse rounded-xl border border-border bg-foreground/10"
                      style={{ animationDelay: `${i * 80}ms` }}
                    />
                  ))}
                </div>
                <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" /> Finding available times…
                </p>
              </div>
            ) : slots.all.length === 0 ? (
              <p className="mt-1.5 text-sm text-muted-foreground">Nothing fits that duration on this day.</p>
            ) : (
              <div className="mt-1.5 grid max-h-44 grid-cols-4 gap-1.5 overflow-y-auto pr-0.5">
                {slots.all.map((s) => {
                  const free = slots.free.has(s)
                  const selected = s === startsAt
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={!free}
                      onClick={() => setStartsAt(s)}
                      className={`rounded-xl border px-1 py-2 text-sm tabular-nums transition ${
                        selected
                          ? 'border-primary bg-primary font-semibold text-primary-foreground shadow-md shadow-primary/30'
                          : free
                            ? 'border-border bg-background hover:border-primary/60 hover:text-primary'
                            : 'cursor-not-allowed border-transparent bg-muted/40 text-muted-foreground/40 line-through'
                      }`}
                    >
                      {timeInZone(s, tz)}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {startsAt && endsAt && (
          <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4 text-sm">
            <p className={label}>New booking</p>
            <p className="mt-1 text-base font-semibold tabular-nums">
              {dateInZone(startsAt, tz)}, {timeInZone(startsAt, tz)}–{timeInZone(endsAt, tz)}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{fmtDur(duration)}</span>
            </p>
            {quoting && <p className="mt-2 text-muted-foreground">Checking price…</p>}
            {quote && (
              <div className="mt-2 flex items-center gap-2 tabular-nums">
                <span className="text-muted-foreground line-through">{formatMoney(quote.oldTotal!, currency)}</span>
                <ArrowRight size={14} className="text-muted-foreground" />
                <strong className="text-base">{formatMoney(quote.newTotal!, currency)}</strong>
                {Math.abs(diff) >= 0.005 && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      diff > 0 ? 'bg-amber-500/15 text-amber-600' : 'bg-emerald-500/15 text-emerald-600'
                    }`}
                  >
                    {diff > 0 ? '+' : '−'}
                    {formatMoney(Math.abs(diff), currency)}
                  </span>
                )}
              </div>
            )}
            {quote && (
              <p className="mt-2 text-xs text-muted-foreground">
                Re-priced at today’s rates for the new time (weekend, happy-hour and holiday rules apply), even if the
                length is unchanged.
              </p>
            )}
            {quote?.discountClamped && (
              <p className="mt-2 text-xs text-amber-600">
                The booking’s discount is larger than the new price, so it is reduced to {formatMoney(quote.newDiscount!, currency)}.
              </p>
            )}
            {quote?.needsRefundReview && (
              <p className="mt-2 text-xs text-amber-600">
                The new total is lower than the money already collected (online deposit or advance). The booking will be
                flagged so the difference can be refunded.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">The customer will be sent a text with the old and new time.</p>
          </div>
        )}

        <div>
          <p className={label}>
            Reason <span className="font-normal normal-case tracking-normal">(required — saved in the audit log)</span>
          </p>
          <input
            type="text"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer asked to start later"
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-card px-6 py-4">
        <button
          type="button"
          className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
          disabled={pending}
          onClick={onClose}
        >
          Keep current time
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/30 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          disabled={!canSave}
          onClick={save}
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          Reschedule
        </button>
      </div>
    </>
  )
}
