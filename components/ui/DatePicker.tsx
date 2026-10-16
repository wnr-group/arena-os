'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays } from '@/lib/booking/time'
import { CHIP_STRIP_MAX_DAYS } from '@/lib/booking/horizon'


const WEEKDAY_HEADS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function parts(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, 12))
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(dt)
  return {
    weekday: fmt({ weekday: 'short' }),
    day: fmt({ day: 'numeric' }),
    month: fmt({ month: 'short' }),
    long: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  }
}

/** Day of week (0 = Sunday) of a plain calendar date — no timezone involved. */
function dow(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, 1, 12)),
  )
}

const chipBase =
  'flex flex-col items-center gap-0.5 rounded-2xl border px-2 py-3 transition-all duration-200 active:scale-95'
const chipOn = 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
const chipOff = 'border-border bg-card text-foreground hover:border-primary/40'

/**
 * The shared date picker for the storefront and the staff future-booking
 * wizard (M37 #3 / #4) - one component, not two. variant="staff" only
 * changes the chip-strip styling to the wizard's denser look.
 *
 * `dates` is the bookable window from the server (dateOptions in
 * lib/booking/horizon.ts). Up to CHIP_STRIP_MAX_DAYS days it is the familiar
 * chip strip; beyond that, a scrollable week-grouped strip with month headings,
 * a "Jump to" month control and a calendar popover. Both drive the same
 * `value`/`onChange`, and neither fetches anything: availability is loaded by
 * the page for the selected date only.
 *
 * `closedWeekdays` (0 = Sunday) are shown struck-through and unselectable in
 * the long picker, where it is known cheaply from the working hours. The chip
 * strip does not change: a closed day there still opens the page's own
 * "closed" notice, as it always has.
 */
export function DatePicker({
  dates,
  value,
  onChange,
  closedWeekdays = [],
  variant = 'public',
}: {
  dates: string[]
  value: string
  onChange: (d: string) => void
  closedWeekdays?: number[]
  variant?: 'public' | 'staff'
}) {
  if (dates.length <= CHIP_STRIP_MAX_DAYS) {
    const staff = variant === 'staff'
    return (
      <div className={staff ? 'mt-3 grid grid-cols-7 gap-1.5 sm:gap-2' : 'mt-3 grid grid-cols-7 gap-2'}>
        {dates.map((d) => {
          const p = parts(d)
          const isSelected = d === value
          return (
            <button
              key={d}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onChange(d)}
              className={
                staff
                  ? `flex flex-col items-center gap-0.5 rounded-xl border px-1 py-2.5 transition-all duration-200 active:scale-95 ${
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : 'border-border bg-card text-foreground hover:border-primary/40'
                    }`
                  : `${chipBase} ${isSelected ? chipOn : chipOff}`
              }
            >
              <span className={`${staff ? 'text-[10px]' : 'text-[11px]'} font-semibold uppercase tracking-wide ${isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                {p.weekday}
              </span>
              <span className={`${staff ? 'text-base' : 'text-lg'} font-bold tabular-nums`}>{p.day}</span>
              <span className={`${staff ? 'text-[10px]' : 'text-[11px]'} font-semibold uppercase tracking-wide ${isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                {p.month}
              </span>
            </button>
          )
        })}
      </div>
    )
  }
  return <LongPicker dates={dates} value={value} onChange={onChange} closedWeekdays={closedWeekdays} />
}

type MonthGroup = { key: string; weeks: string[][] }

/** Window dates grouped month → Sunday-started weeks. */
function groupDates(dates: string[]): MonthGroup[] {
  const months: MonthGroup[] = []
  for (const d of dates) {
    const key = d.slice(0, 7)
    let m = months[months.length - 1]
    if (!m || m.key !== key) {
      m = { key, weeks: [] }
      months.push(m)
    }
    let w = m.weeks[m.weeks.length - 1]
    if (!w || dow(d) === 0) {
      w = []
      m.weeks.push(w)
    }
    w.push(d)
  }
  return months
}

function LongPicker({
  dates,
  value,
  onChange,
  closedWeekdays,
}: {
  dates: string[]
  value: string
  onChange: (d: string) => void
  closedWeekdays: number[]
}) {
  const uid = useId()
  const first = dates[0]
  const last = dates[dates.length - 1]
  const months = useMemo(() => groupDates(dates), [dates])
  const closed = useMemo(() => new Set(closedWeekdays), [closedWeekdays])
  const stripRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const isClosedDay = (d: string) => closed.has(dow(d))
  const inWindow = (d: string) => d >= first && d <= last

  // Keep the chosen date in view when it changes (including from the calendar).
  useEffect(() => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-date="${value}"]`)
    if (!strip || !el) return
    const left = el.offsetLeft - strip.offsetLeft
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: Math.max(0, left - 12), behavior: 'smooth' })
    }
  }, [value])

  function jumpTo(monthKey: string) {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-month="${monthKey}"]`)
    if (!strip || !el) return
    strip.scrollTo({ left: Math.max(0, el.offsetLeft - strip.offsetLeft), behavior: 'smooth' })
  }

  return (
    <div className="relative mt-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          Jump to
          <select
            aria-label="Jump to month"
            onChange={(e) => jumpTo(e.target.value)}
            defaultValue={value.slice(0, 7)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-medium text-foreground"
          >
            {months.map((m) => (
              <option key={m.key} value={m.key}>
                {monthLabel(m.key)}
              </option>
            ))}
          </select>
        </label>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={`${uid}-cal`}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <CalendarDays size={14} aria-hidden="true" />
          Calendar
        </button>
        <span className="text-sm font-semibold text-foreground" aria-live="polite">
          {parts(value).long}
        </span>
      </div>

      <div
        ref={stripRef}
        role="group"
        aria-label="Pick a date"
        className="relative mt-3 flex snap-x snap-proximity gap-5 overflow-x-auto pb-3"
      >
        {months.map((m) => (
          <div key={m.key} data-month={m.key} className="shrink-0">
            <h3 className="sticky left-0 mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              {monthLabel(m.key)}
            </h3>
            <div className="flex gap-3">
              {m.weeks.map((week) => (
                <div key={week[0]} className="flex snap-start gap-1.5">
                  {week.map((d) => {
                    const p = parts(d)
                    const isSelected = d === value
                    const isClosed = isClosedDay(d) && !isSelected
                    return (
                      <button
                        key={d}
                        type="button"
                        data-date={d}
                        aria-pressed={isSelected}
                        aria-label={`${p.long}${isClosed ? ', closed' : ''}`}
                        disabled={isClosed}
                        title={isClosed ? 'Closed' : undefined}
                        onClick={() => onChange(d)}
                        className={`${chipBase} w-14 shrink-0 px-1 ${isSelected ? chipOn : chipOff} ${
                          isClosed ? 'cursor-not-allowed opacity-45 line-through' : ''
                        }`}
                      >
                        <span className={`text-[11px] font-semibold uppercase tracking-wide ${isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                          {p.weekday}
                        </span>
                        <span className="text-lg font-bold tabular-nums">{p.day}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {open && (
        <CalendarPopover
          id={`${uid}-cal`}
          triggerRef={triggerRef}
          first={first}
          last={last}
          value={value}
          isClosedDay={isClosedDay}
          inWindow={inWindow}
          onPick={(d) => {
            onChange(d)
            setOpen(false)
            triggerRef.current?.focus()
          }}
          onClose={() => {
            setOpen(false)
            triggerRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function CalendarPopover({
  id,
  triggerRef,
  first,
  last,
  value,
  isClosedDay,
  inWindow,
  onPick,
  onClose,
}: {
  id: string
  /** The button that opened the popover; its clicks must not count as "outside". */
  triggerRef: React.RefObject<HTMLButtonElement | null>
  first: string
  last: string
  value: string
  isClosedDay: (d: string) => boolean
  inWindow: (d: string) => boolean
  onPick: (d: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [month, setMonth] = useState(value.slice(0, 7))
  const monthFirst = `${month}-01`
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lead = dow(monthFirst)
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ]
  const shift = (key: string, by: number) => {
    const [yy, mm] = key.split('-').map(Number)
    const d = new Date(Date.UTC(yy, mm - 1 + by, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  const canPrev = shift(month, -1) >= first.slice(0, 7)
  const canNext = shift(month, 1) <= last.slice(0, 7)
  const today = first

  // Focus the chosen day (or the first enabled one) when the dialog opens.
  useEffect(() => {
    const el =
      ref.current?.querySelector<HTMLElement>(`[data-cal-date="${value}"]:not(:disabled)`) ??
      ref.current?.querySelector<HTMLElement>('[data-cal-date]:not(:disabled)')
    el?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Click outside closes.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      if (ref.current && !ref.current.contains(target) && !triggerRef.current?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose, triggerRef])

  function focusDate(d: string) {
    if (!inWindow(d)) return
    if (d.slice(0, 7) !== month) {
      setMonth(d.slice(0, 7))
      // Wait for the new month to render before focusing.
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-cal-date="${d}"]`)?.focus())
    } else {
      ref.current?.querySelector<HTMLElement>(`[data-cal-date="${d}"]`)?.focus()
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Tab') {
      // Focus trap: cycle through the dialog's enabled controls.
      const f = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
      if (f.length === 0) return
      const i = f.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1
      e.preventDefault()
      f[next].focus()
      return
    }
    const active = document.activeElement as HTMLElement | null
    const cur = active?.dataset.calDate
    if (!cur) return
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key in step) {
      e.preventDefault()
      let d = addDays(cur, step[e.key])
      // Skip over closed days in the direction of travel, staying inside the window.
      while (inWindow(d) && isClosedDay(d) && d !== value) d = addDays(d, step[e.key] > 0 ? 1 : -1)
      focusDate(d)
    }
  }

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a date"
      onKeyDown={onKeyDown}
      className="absolute left-0 z-30 mt-2 w-[min(20rem,100%)] rounded-2xl border border-border bg-card p-3 shadow-xl"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!canPrev}
          onClick={() => setMonth(shift(month, -1))}
          className="rounded-lg p-2 hover:bg-muted disabled:opacity-30"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <h3 className="text-sm font-bold" aria-live="polite">
          {monthLabel(month)}
        </h3>
        <button
          type="button"
          aria-label="Next month"
          disabled={!canNext}
          onClick={() => setMonth(shift(month, 1))}
          className="rounded-lg p-2 hover:bg-muted disabled:opacity-30"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-muted-foreground" aria-hidden="true">
        {WEEKDAY_HEADS.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <span key={`b${i}`} />
          const outside = !inWindow(d)
          const isSelected = d === value
          const isClosed = isClosedDay(d) && !isSelected
          const disabled = outside || isClosed
          return (
            <button
              key={d}
              type="button"
              data-cal-date={d}
              disabled={disabled}
              aria-pressed={isSelected}
              aria-label={`${parts(d).long}${isClosed ? ', closed' : ''}${d === today ? ', today' : ''}`}
              title={isClosed ? 'Closed' : undefined}
              onClick={() => onPick(d)}
              className={`aspect-square rounded-lg text-sm font-medium tabular-nums transition ${
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : d === today
                    ? 'border border-primary text-foreground hover:bg-muted'
                    : 'hover:bg-muted'
              } ${outside ? 'cursor-not-allowed opacity-25' : ''} ${isClosed ? 'cursor-not-allowed opacity-45 line-through' : ''}`}
            >
              {Number(d.slice(8, 10))}
            </button>
          )
        })}
      </div>
    </div>
  )
}
