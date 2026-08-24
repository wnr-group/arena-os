import { CalendarDays, Sparkles, Wallet } from 'lucide-react'
import { getPortalSummary } from '@/lib/portal/account'
import { formatMoney } from '@/lib/format'

/**
 * The portal home (AROS-88).
 *
 * A shell page whose job is to prove the whole stack works end to end: the
 * guard resolved a customer, withCustomer() opened a customer-scoped
 * transaction, and RLS returned exactly that customer's rows. The individual
 * sections it summarises get real pages in AROS-89 (bookings), AROS-91
 * (profile) and AROS-92 (wallet & loyalty).
 *
 * No customer id appears anywhere on this page — not as a prop, not as a
 * param. The identity comes from the session inside getPortalSummary().
 */
export default async function AccountPage() {
  const summary = await getPortalSummary()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {summary.account.name ? `Hello, ${summary.account.name}` : 'Your account'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your bookings, wallet and rewards at this venue.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={<CalendarDays size={16} />}
          label="Upcoming bookings"
          value={String(summary.upcomingBookings)}
          hint={`${summary.totalBookings} in total`}
        />
        <StatCard
          icon={<Wallet size={16} />}
          label="Wallet balance"
          value={formatMoney(summary.walletBalance)}
        />
        <StatCard
          icon={<Sparkles size={16} />}
          label="Loyalty points"
          value={String(summary.loyaltyPoints)}
        />
      </div>

      {summary.membership && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Membership</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.membership.planName} · {summary.membership.discountPercent}% off · valid until{' '}
            {summary.membership.expiresAt.toLocaleDateString()}
          </p>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Recent bookings</h2>
        {summary.recentBookings.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            You have no bookings at this venue yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {summary.recentBookings.map((booking) => (
              <li
                key={booking.id}
                className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{booking.bookingNumber}</p>
                  <p className="text-xs text-muted-foreground">
                    {booking.createdAt.toLocaleDateString()} · {booking.status.replace('_', ' ')}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums">{formatMoney(booking.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
