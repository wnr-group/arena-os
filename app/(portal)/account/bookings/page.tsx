import { getPortalBookings } from '@/lib/portal/bookings'
import { portalTenant } from '@/lib/portal/tenant'
import { BookingSection } from '@/components/portal/BookingRow'
import { Pager } from '@/components/portal/Pager'

type Search = { upcoming?: string; past?: string }

/**
 * My bookings (AROS-89) — read-only.
 *
 * The two sections are independent: each renders its own empty message, so a
 * customer with history but nothing booked still sees their past, and a brand
 * new customer sees both prompts rather than a blank page.
 *
 * That independence extends to paging. Each section carries its OWN page in the
 * query string (?upcoming=2&past=3) and every pager link preserves the other's,
 * so moving through history does not quietly send Upcoming back to page 1. The
 * page numbers are passed to the reader raw — it clamps them, being the only
 * place that knows how many pages each list actually has — and the clamped
 * values come back in `pagination` for the pagers to render. That is why the UI
 * never disagrees with the rows on screen even when someone edits the URL.
 *
 * No customer id appears anywhere on this page, in a param or otherwise.
 * getPortalBookings() takes only page numbers — it resolves the customer from
 * the session and lets RLS scope the rows.
 */
export default async function PortalBookingsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const sp = await searchParams
  const [tenant, { upcoming, past, pagination, policy }] = await Promise.all([
    portalTenant(),
    getPortalBookings({ upcoming: Number(sp.upcoming), past: Number(sp.past) }),
  ])

  /**
   * A URL with one section's page changed and the other's kept.
   *
   * Built from the CLAMPED page the reader returned rather than from the raw
   * query string, so a nonsense ?past=abc is not carried forward into every
   * link on the page. Page 1 is omitted — the default needs no parameter, and
   * a bare /account/bookings is the tidier thing to share.
   */
  const hrefFor = (section: 'upcoming' | 'past') => (page: number) => {
    const params = new URLSearchParams()
    const next = { upcoming: pagination.upcoming.page, past: pagination.past.page, [section]: page }
    if (next.upcoming > 1) params.set('upcoming', String(next.upcoming))
    if (next.past > 1) params.set('past', String(next.past))
    const query = params.toString()
    // The fragment lands the browser on the section that changed, rather than
    // at the top of a page whose visible half did not move.
    return `/account/bookings${query ? `?${query}` : ''}#${section}`
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My bookings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you have booked at {tenant.name}.
        </p>
      </div>

      <div id="upcoming" className="scroll-mt-6">
        <BookingSection
          title="Upcoming"
          emptyMessage="No upcoming bookings."
          bookings={upcoming}
          count={pagination.upcoming.total}
          timeZone={tenant.timezone}
          currency={tenant.currency}
          cutoffHours={policy.cutoffHours}
          footer={
            <Pager info={pagination.upcoming} label="Upcoming bookings" hrefFor={hrefFor('upcoming')} />
          }
        />
      </div>

      <div id="past" className="scroll-mt-6">
        <BookingSection
          title="Past"
          emptyMessage="No booking history yet."
          bookings={past}
          count={pagination.past.total}
          timeZone={tenant.timezone}
          currency={tenant.currency}
          cutoffHours={policy.cutoffHours}
          showRebook
          footer={<Pager info={pagination.past} label="Past bookings" hrefFor={hrefFor('past')} />}
        />
      </div>
    </div>
  )
}
