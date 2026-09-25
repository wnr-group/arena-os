'use client'

import { useMemo, useState } from 'react'
import { ArrowLeft, Ban, CalendarClock, CheckCircle2, Gamepad2, Sparkles, Users } from 'lucide-react'
import { formatMoney, timeInZone } from '@/lib/format'
import { computeAvailabilityWindow, formatAvailableWindow } from '@/lib/booking/walkin-availability'
import { SelectableTile } from './wizard-ui'

/**
 * The "check availability" calendar shown before a walk-in is started (M23).
 *
 * PRE-BOOKING VIEW ONLY — a completely separate component from the existing
 * Bookings-page Timeline (components/bookings/BookingsView.tsx), which is
 * left untouched. This one's whole job is to answer, per device, "is it free
 * right now, and if so, for how long before the next real booking" — nothing
 * here creates a booking. Picking a device just reports it back to the
 * caller (WalkinWizard) via `onSelect`; WalkinWizard still owns every bit of
 * form state and the actual startWalkin() call, so booking-creation logic
 * lives in exactly one place, same as before this component existed.
 *
 * An open walk-in has no end time until checkout (see lib/booking/walkin.ts's
 * module doc comment) — this component never invents one. "Available until
 * 5:00 PM" is a DISPLAY of the gap up to the next real booking, computed by
 * lib/booking/walkin-availability.ts; nothing here is ever written back as
 * the walk-in's ends_at.
 */

export type WalkinAvailabilityResource = {
  id: string
  name: string
  resourceTypeId: string
  typeName: string
  hourlyRate: string
  typeHourlyRate: string
  weekendRate: string | null
  capacity: number | null
  pricingMode: string
  minPlayers: number
  /** No active booking on it right now. An occupied resource is shown (per
   *  the GOAL of seeing occupied vs. free at a glance) but is never
   *  selectable — a walk-in can only ever start on a free unit. */
  isFree: boolean
  /** This resource's own next active (confirmed/checked_in) booking, if any.
   *  Independent per resource — Snooker #1 having one has no bearing on
   *  Snooker #2's or #3's. */
  nextBooking: {
    startsAt: string
    endsAt: string | null
    bookingNumber: string
    customerName: string | null
  } | null
}

/** The visual time axis's span — long enough to cover the longest a timed
 *  walk-in can run (WALKIN_MAX_DURATION_MINUTES, lib/booking/walkin.ts), so
 *  the bar for a fully-open evening doesn't feel arbitrarily truncated. A
 *  next booking further out than this still gets an entirely accurate
 *  headline ("Available for 6h 10m") — the axis is only ever a picture, the
 *  numbers never round to what fits on screen. */
const AXIS_HOURS = 5
const AXIS_MINUTES = AXIS_HOURS * 60

export function WalkInAvailabilityCalendar({
  resources,
  timeZone,
  currency,
  startAtIso,
  selectedResourceId,
  onSelect,
}: {
  resources: WalkinAvailabilityResource[]
  timeZone: string
  currency: string
  /** The instant a walk-in started here would begin — "now", nudged by the
   *  wizard's own start-time offset control. Purely read here for the window
   *  math and the axis's left edge; this component never owns or changes it. */
  startAtIso: string
  selectedResourceId: string | null
  onSelect: (resource: WalkinAvailabilityResource) => void
}) {
  // Every resource type, each carrying its own rows. Staff first pick a
  // device TYPE (a card grid, same shape as FutureWizard's type picker) and
  // only then see this type's rows and their availability bars — one type
  // at a time, rather than every type's rows stacked on the page at once.
  const types = useMemo(() => {
    const byType = new Map<
      string,
      { id: string; name: string; hourlyRate: string; pricingMode: string; capacity: number | null; rows: WalkinAvailabilityResource[] }
    >()
    for (const r of resources) {
      if (!byType.has(r.resourceTypeId)) {
        byType.set(r.resourceTypeId, {
          id: r.resourceTypeId,
          name: r.typeName,
          hourlyRate: r.typeHourlyRate,
          pricingMode: r.pricingMode,
          capacity: r.capacity,
          rows: [],
        })
      }
      byType.get(r.resourceTypeId)!.rows.push(r)
    }
    return [...byType.values()]
  }, [resources])

  const selected = resources.find((r) => r.id === selectedResourceId) ?? null
  const selectedWindow = selected ? computeAvailabilityWindow(startAtIso, selected.nextBooking?.startsAt ?? null) : null

  // Which device TYPE's rows are on screen. Lazily seeded from whatever
  // resource is already picked (e.g. this component remounting because the
  // wizard's step-0 block was re-entered via Back) so returning to this step
  // drops straight back into that type's calendar instead of the card grid.
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(() => {
    if (!selectedResourceId) return null
    return resources.find((r) => r.id === selectedResourceId)?.resourceTypeId ?? null
  })
  const activeType = types.find((t) => t.id === selectedTypeId) ?? null

  if (types.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center shadow-sm">
        <p className="text-sm text-muted-foreground">No walk-in stations are set up yet.</p>
      </div>
    )
  }

  if (!activeType) {
    return (
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Which device type?</p>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {types.map((t) => {
            // "Free" here means bookable at the CHOSEN start time, not merely
            // unoccupied this instant — same rule a row's own button uses
            // below, kept consistent so the card's count never promises a
            // pick the row grid would then refuse.
            const freeCount = t.rows.filter(
              (r) => r.isFree && computeAvailabilityWindow(startAtIso, r.nextBooking?.startsAt ?? null).status !== 'unavailable',
            ).length
            return (
              <SelectableTile
                key={t.id}
                selected={false}
                onClick={() => setSelectedTypeId(t.id)}
                icon={<Gamepad2 size={18} />}
                title={t.name}
                subtitle={`${formatMoney(Number(t.hourlyRate), currency)}/${t.pricingMode === 'per_head' ? 'player' : 'hr'}`}
                badge={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-xs font-semibold ${freeCount > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}>
                      {freeCount} of {t.rows.length} free
                    </span>
                    {t.capacity != null && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <Users size={12} /> up to {t.capacity}
                      </span>
                    )}
                  </span>
                }
              />
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/[0.04] ring-1 ring-border/40">
      {/* back to the type-card grid, plus which type is on screen now */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setSelectedTypeId(null)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
        >
          <ArrowLeft size={13} /> Change device type
        </button>
        <div className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary-hover text-primary-foreground shadow-sm">
            <Gamepad2 size={11} />
          </span>
          <p className="text-xs font-bold uppercase tracking-wide text-foreground">{activeType.name}</p>
          <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-primary">
            {formatMoney(Number(activeType.hourlyRate), currency)}/{activeType.pricingMode === 'per_head' ? 'player' : 'hr'}
          </span>
          {activeType.capacity != null && (
            <span className="text-[11px] font-medium text-muted-foreground">· up to {activeType.capacity}</span>
          )}
        </div>
      </div>

      {/* time axis header — shared by this type's rows below */}
      <div className="flex text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        <div className="w-40 shrink-0" />
        <div className="relative h-5 flex-1">
          {Array.from({ length: AXIS_HOURS + 1 }, (_, i) => i).map((h) => (
            <span key={h} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${(h / AXIS_HOURS) * 100}%` }}>
              {h === 0 ? timeInZone(startAtIso, timeZone) : timeInZone(addMinutesIso(startAtIso, h * 60), timeZone)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-2.5 space-y-2">
        {activeType.rows.map((r) => {
          const window = computeAvailabilityWindow(startAtIso, r.nextBooking?.startsAt ?? null)
          const isSelected = r.id === selectedResourceId
          return (
            <button
              key={r.id}
              type="button"
              disabled={!r.isFree}
              onClick={() => r.isFree && onSelect(r)}
              className={`group relative flex w-full items-stretch gap-0 overflow-hidden rounded-2xl border text-left transition-all duration-200 ${
                !r.isFree
                  ? 'cursor-not-allowed border-border/60 bg-muted/30 opacity-70'
                  : isSelected
                    ? 'border-primary bg-accent/60 shadow-[0_4px_16px_-6px_rgba(139,34,66,0.35)] ring-1 ring-primary/30'
                    : 'cursor-pointer border-border bg-card hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-safe:hover:-translate-y-0.5'
              }`}
            >
              <div className="flex w-40 shrink-0 items-center gap-2.5 px-3.5 py-3">
                <span
                  className={`flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
                    isSelected
                      ? 'bg-gradient-to-br from-primary to-primary-hover text-primary-foreground shadow-sm'
                      : r.isFree
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Gamepad2 size={16} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-foreground">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatMoney(Number(r.hourlyRate), currency)}/{r.pricingMode === 'per_head' ? 'player' : 'hr'}
                  </p>
                </div>
              </div>

              <div className="relative min-h-16 flex-1 border-l border-border/60 py-2.5 pr-2.5">
                {!r.isFree ? (
                  <div className="flex h-full items-center gap-1.5 pl-3 text-xs font-semibold text-destructive/90">
                    <span className="flex size-5 items-center justify-center rounded-full bg-destructive/10">
                      <Ban size={11} />
                    </span>
                    Occupied right now
                  </div>
                ) : (
                  <ResourceAvailabilityBar startAtIso={startAtIso} window={window} timeZone={timeZone} isSelected={isSelected} />
                )}
              </div>

              {isSelected && (
                <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                  <CheckCircle2 size={13} strokeWidth={2.5} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* selection summary */}
      {selected && selectedWindow && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.06] via-card to-card shadow-sm">
          <div className="flex items-center gap-2 border-b border-primary/15 bg-primary/[0.04] px-4 py-2.5">
            <Sparkles size={13} className="text-primary" />
            <p className="text-xs font-bold uppercase tracking-wide text-primary">Availability summary</p>
          </div>
          <div className="p-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <SummaryItem k="Selected resource" v={selected.name} />
              <SummaryItem k="Start" v={timeInZone(startAtIso, timeZone)} />
              <SummaryItem k="Next booking" v={selected.nextBooking ? timeInZone(selected.nextBooking.startsAt, timeZone) : 'None'} />
              <SummaryItem
                k="Available window"
                v={
                  selectedWindow.status === 'open_ended'
                    ? 'Open-ended'
                    : selectedWindow.status === 'unavailable'
                      ? '—'
                      : formatAvailableWindow(selectedWindow.availableMinutes)
                }
              />
            </dl>
            <StatusBanner window={selectedWindow} timeZone={timeZone} />
          </div>
        </div>
      )}
    </div>
  )
}

/** One row's mini timeline: an AVAILABLE segment from the selected start,
 *  up to whichever comes first — the visual axis edge or the next booking —
 *  followed by a BOOKED segment when that next booking falls within view. */
function ResourceAvailabilityBar({
  startAtIso,
  window,
  timeZone,
  isSelected,
}: {
  startAtIso: string
  window: ReturnType<typeof computeAvailabilityWindow>
  timeZone: string
  isSelected: boolean
}) {
  const availableMinutes = window.status === 'available' ? window.availableMinutes : AXIS_MINUTES
  const visibleAvailable = Math.min(availableMinutes, AXIS_MINUTES)
  const availableWidthPct = (visibleAvailable / AXIS_MINUTES) * 100
  const bookedWidthPct = window.status === 'available' ? 100 - availableWidthPct : 0

  return (
    <div className="relative h-full min-h-12 pl-3">
      {/* hour gridlines, matching the header above */}
      {Array.from({ length: AXIS_HOURS + 1 }, (_, i) => i).map((h) => (
        <span key={h} className="absolute inset-y-0 w-px bg-border/70" style={{ left: `calc(${(h / AXIS_HOURS) * 100}% + 0.1px)` }} />
      ))}

      {/* start marker — a small pulsing dot, the same "live" cue the
          Bookings-page Timeline uses for an ongoing walk-in bar. */}
      <span className="absolute -top-0.5 z-20 flex -translate-x-1/2 items-center" style={{ left: '0%' }} title={`Start ${timeInZone(startAtIso, timeZone)}`}>
        <span className={`size-2 rounded-full ring-2 ring-card ${isSelected ? 'bg-primary' : 'bg-foreground/70'}`} />
      </span>
      <span
        className={`absolute inset-y-0.5 z-10 w-0.5 rounded-full ${isSelected ? 'bg-primary' : 'bg-foreground/50'}`}
        style={{ left: '0%' }}
      />

      {window.status === 'unavailable' ? (
        <div className="absolute inset-y-1.5 left-1 right-1 flex items-center gap-1.5 rounded-full bg-gradient-to-r from-destructive/15 to-destructive/5 px-3 text-xs font-semibold text-destructive shadow-sm ring-1 ring-destructive/20">
          <Ban size={12} /> Overlaps the next booking
        </div>
      ) : (
        <>
          <div
            className="absolute inset-y-1.5 flex items-center overflow-hidden rounded-l-full pl-3 text-xs font-semibold text-emerald-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] dark:text-emerald-300"
            style={{
              left: '0%',
              width: `${availableWidthPct}%`,
              background: 'linear-gradient(90deg, rgba(16,185,129,0.22), rgba(16,185,129,0.09))',
            }}
          >
            <span className="truncate">{window.status === 'open_ended' ? 'Open — no upcoming booking' : 'Available'}</span>
          </div>
          {window.status === 'available' && bookedWidthPct > 0 && (
            <div
              className="absolute inset-y-1.5 right-1 flex items-center overflow-hidden rounded-r-full bg-gradient-to-r from-zinc-500 to-zinc-600 px-3 text-xs font-semibold text-white shadow-sm dark:from-zinc-600 dark:to-zinc-700"
              style={{ left: `${availableWidthPct}%`, width: `${bookedWidthPct}%` }}
              title={window.nextBookingStartsAt ? `Booked from ${timeInZone(window.nextBookingStartsAt, timeZone)}` : undefined}
            >
              <span className="truncate">Booked {timeInZone(window.nextBookingStartsAt, timeZone)}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** A colour-coded pill stating the outcome in one line — green for anything
 *  bookable, red for the one state that refuses a start here. */
function StatusBanner({ window, timeZone }: { window: ReturnType<typeof computeAvailabilityWindow>; timeZone: string }) {
  const isBlocked = window.status === 'unavailable'
  return (
    <p
      className={`mt-3.5 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold ${
        isBlocked ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      }`}
    >
      {isBlocked ? <Ban size={15} className="shrink-0" /> : <CalendarClock size={15} className="shrink-0" />}
      {statusMessage(window, timeZone)}
    </p>
  )
}

function statusMessage(window: ReturnType<typeof computeAvailabilityWindow>, timeZone: string): string {
  if (window.status === 'open_ended') return 'No upcoming booking — open walk-in can continue until checkout.'
  if (window.status === 'unavailable') return 'This start time overlaps the next booking — pick an earlier start or a different device.'
  return `Available for an open walk-in until ${timeInZone(window.nextBookingStartsAt, timeZone)} (${formatAvailableWindow(window.availableMinutes)} before the next booking).`
}

function SummaryItem({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground/80">{k}</dt>
      <dd className="mt-0.5 truncate font-bold text-foreground">{v}</dd>
    </div>
  )
}

function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()
}
