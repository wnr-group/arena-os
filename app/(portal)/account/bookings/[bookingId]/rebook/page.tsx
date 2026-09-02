import { notFound, redirect } from 'next/navigation'
import { withCustomer } from '@/db'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { readPortalBooking } from '@/lib/portal/bookings'
import { getBookingMeta } from '@/lib/portal/cancel'

/**
 * "Book this again" (AROS-90) — a redirect, not a booking flow.
 *
 * ── What this route deliberately does NOT do ────────────────────────────────
 *
 * It does not clone the booking, and it does not copy booking_slots. Cloning a
 * slot would write a reservation that never passed an availability check, and
 * the only reason it would not immediately double-book is the exclusion
 * constraint — i.e. it would fail loudly at best and take a slot somebody else
 * was mid-way through picking at worst.
 *
 * Instead the original booking is used purely as a source of PREFILL, and the
 * customer is handed to the existing public booking flow
 * (app/(public)/book-type/[resourceTypeId]) to choose a new date and time.
 * That flow already owns availability (getPublicAvailability), creation
 * (createPublicBooking → createBookingCore) and the overlap guarantee
 * (booking_slots_no_overlap). None of it is duplicated or bypassed here.
 *
 * ── Why a server redirect rather than a link with the ids baked in ──────────
 *
 * Resolving the resource type needs `resources`, which has no customer policy
 * at all — the portal cannot read the live catalogue. Doing it here means one
 * ownership-checked lookup at click time (customer_booking_meta, migration
 * 0047) instead of a per-row join on the list page, and it keeps the booking id
 * out of the public flow's URL entirely.
 *
 * The query string that survives into the public flow carries only `duration`
 * and `players` — no ids, no phone, nothing that identifies anybody. Both are
 * ordinary form defaults that the public flow re-validates on submit, so a
 * tampered value is no more dangerous than typing a different number into the
 * form by hand.
 */
export default async function RebookPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const { bookingId } = await params
  const customer = await requireCustomer()

  const prefill = await withCustomer(customer.id, async (tx) => {
    // RLS-scoped: another customer's booking id returns null here, exactly as
    // it does on the detail page.
    const booking = await readPortalBooking(tx, customer.tenantId, bookingId)
    if (!booking) return null

    const meta = await getBookingMeta(tx, bookingId)
    if (!meta?.rebookResourceTypeId) return null

    return {
      resourceTypeId: meta.rebookResourceTypeId,
      durationMinutes: durationOf(booking.startsAt, booking.endsAt),
      players: playersFromNotes(booking.notes),
    }
  })

  // Not theirs, gone, or a booking whose resource type no longer exists —
  // all the same 404, so nothing is confirmed to a caller walking UUIDs.
  if (!prefill) notFound()

  const search = new URLSearchParams()
  if (prefill.durationMinutes) search.set('duration', String(prefill.durationMinutes))
  if (prefill.players) search.set('players', String(prefill.players))

  const query = search.toString()
  redirect(`/book-type/${prefill.resourceTypeId}${query ? `?${query}` : ''}`)
}

/**
 * The original booking's length, snapped to the 30-minute steps the public
 * wizard offers. Returns null when it cannot be derived, in which case the
 * wizard keeps its own default rather than being handed a nonsense value.
 */
function durationOf(startsAt: Date | null, endsAt: Date | null): number | null {
  if (!startsAt || !endsAt) return null
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  const snapped = Math.round(minutes / 30) * 30
  // The same bounds the public availability action enforces, so a prefill can
  // never ask for a duration that action would reject.
  if (snapped < 30 || snapped > 240) return null
  return snapped
}

/**
 * Player count, recovered from the note the public booking flow writes.
 *
 * There is no per-booking player column in the schema, so createPublicBooking
 * records it as `Players: N` in `notes` (see lib/actions/public-booking.ts).
 * Reading it back is therefore the only way to carry the party size across, and
 * a booking made by staff — which has free-text notes — simply yields null.
 */
function playersFromNotes(notes: string | null): number | null {
  const match = notes?.match(/Players:\s*(\d{1,3})/i)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null
}
