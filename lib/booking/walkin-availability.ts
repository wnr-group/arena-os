/**
 * Pure calculation behind the walk-in "check availability" calendar
 * (components/bookings/new/WalkInAvailabilityCalendar.tsx) — no DB, no React,
 * so it can be pinned with a plain script (scripts/test-walkin-availability.ts)
 * the same way lib/format.ts's prettyDate() is.
 *
 * The one rule this exists to enforce: an open walk-in has NO end time until
 * checkout (see lib/booking/walkin.ts's module doc comment). This file never
 * invents one — "available window" is always measured up to the next REAL
 * booking on the resource, or reported as open-ended when there isn't one.
 * Nothing here writes a fake ends_at anywhere; it only decides what the
 * calendar should show before a walk-in is even started.
 */

export type AvailabilityWindow =
  | {
      /** No booking scheduled on this resource after the chosen start —
       *  an open walk-in here can run until checkout, whenever that is. */
      status: 'open_ended'
    }
  | {
      /** Free from the chosen start up to `nextBookingStartsAt`. */
      status: 'available'
      nextBookingStartsAt: string
      availableMinutes: number
    }
  | {
      /** The chosen start is at or past the next booking's own start — there
       *  is no window to offer here at all. */
      status: 'unavailable'
      nextBookingStartsAt: string
    }

/**
 * `startAtIso`: the instant the walk-in would begin (staff's chosen start
 * time — "now", nudged by the wizard's ±30-min offset).
 * `nextBookingStartsAtIso`: the resource's next active (confirmed/checked_in)
 * booking's start, or null when there isn't one — straight off
 * listWalkinResources' per-resource `nextBooking`.
 */
export function computeAvailabilityWindow(
  startAtIso: string,
  nextBookingStartsAtIso: string | null,
): AvailabilityWindow {
  if (!nextBookingStartsAtIso) return { status: 'open_ended' }

  const start = new Date(startAtIso).getTime()
  const next = new Date(nextBookingStartsAtIso).getTime()

  // Equal counts as unavailable, not a zero-minute window — starting a walk-in
  // AT the moment another booking begins is exactly the case the exclusion
  // constraint (0003) would reject anyway.
  if (start >= next) return { status: 'unavailable', nextBookingStartsAt: nextBookingStartsAtIso }

  return {
    status: 'available',
    nextBookingStartsAt: nextBookingStartsAtIso,
    availableMinutes: Math.round((next - start) / 60_000),
  }
}

/** "30 minutes" / "1h 17m" / "3 hours" / "1 hour" — matches how staff would
 *  say it out loud, not a fixed "Xh Ym" pattern regardless of magnitude. */
export function formatAvailableWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (rest === 0) return hours === 1 ? '1 hour' : `${hours} hours`
  return `${hours}h ${rest}m`
}
