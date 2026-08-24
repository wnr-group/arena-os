import { getPortalBookings } from '@/lib/portal/bookings'
import { portalTenant } from '@/lib/portal/tenant'
import { BookingSection } from '@/components/portal/BookingRow'

/**
 * My bookings (AROS-89) — read-only.
 *
 * The two sections are independent: each renders its own empty message, so a
 * customer with history but nothing booked still sees their past, and a brand
 * new customer sees both prompts rather than a blank page.
 *
 * No customer id appears anywhere on this page, in a param or otherwise.
 * getPortalBookings() takes no arguments at all — it resolves the customer from
 * the session and lets RLS scope the rows.
 */
export default async function PortalBookingsPage() {
  const [tenant, { upcoming, past, policy }] = await Promise.all([
    portalTenant(),
    getPortalBookings(),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My bookings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you have booked at {tenant.name}.
        </p>
      </div>

      <BookingSection
        title="Upcoming"
        emptyMessage="No upcoming bookings."
        bookings={upcoming}
        timeZone={tenant.timezone}
        currency={tenant.currency}
        cutoffHours={policy.cutoffHours}
      />

      <BookingSection
        title="Past"
        emptyMessage="No booking history yet."
        bookings={past}
        timeZone={tenant.timezone}
        currency={tenant.currency}
        cutoffHours={policy.cutoffHours}
        showRebook
      />
    </div>
  )
}
