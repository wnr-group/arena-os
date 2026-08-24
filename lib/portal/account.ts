import 'server-only'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { withCustomer } from '@/db'
import {
  customers,
  bookings,
  walletTransactions,
  loyaltyTransactions,
  customerMemberships,
} from '@/db/schema'
import { requireCustomer } from '@/lib/auth/customer-guard'

/**
 * Portal reads — everything the signed-in customer's own pages render.
 *
 * ── The rule every reader in this directory follows ─────────────────────────
 *
 *   1. Resolve the customer from the SESSION (requireCustomer()). Never from a
 *      route param, a form field, a header or a prop — a customer id supplied
 *      by the browser is an input, not an authorisation.
 *   2. Open the transaction with withCustomer(), so RLS
 *      (0045_customer_portal_rls.sql) scopes every row to that customer.
 *   3. Return plain serialisable data.
 *
 * ownerDb is never used here. It bypasses RLS entirely, so a single owner-
 * connection read on this path would silently discard the whole guarantee the
 * migration exists to provide. The only customer-portal code that legitimately
 * touches the owner connection is session management itself
 * (lib/auth/customer-session.ts), which mirrors how staff `sessions` work.
 *
 * The queries below still pass no customer id at all — they do not need to.
 * RLS has already narrowed each table to the caller's own rows, which is why
 * `select count(*) from bookings` is a correct "my bookings" count here. The
 * one exception is the `customers` read, which is keyed on the session's id so
 * the query states its intent rather than relying on the row limit.
 */

export type PortalAccount = {
  id: string
  name: string | null
  phone: string
  email: string | null
}

export type PortalMembership = {
  planName: string
  expiresAt: Date
  discountPercent: string
}

export type PortalSummary = {
  account: PortalAccount
  upcomingBookings: number
  totalBookings: number
  walletBalance: number
  loyaltyPoints: number
  membership: PortalMembership | null
  recentBookings: PortalBooking[]
}

export type PortalBooking = {
  id: string
  bookingNumber: string
  status: string
  total: string
  createdAt: Date
}

/** How much history the portal home shows before AROS-89 gives it a real page. */
const RECENT_LIMIT = 5

/**
 * Everything the portal home renders, in ONE customer-scoped transaction.
 *
 * One transaction rather than several so the page is internally consistent —
 * a wallet balance and the ledger it came from should not be able to disagree
 * because a top-up landed between two round trips.
 */
export async function getPortalSummary(): Promise<PortalSummary> {
  const customer = await requireCustomer()

  return withCustomer(customer.id, async (tx) => {
    const [account] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
      })
      .from(customers)
      .where(eq(customers.id, customer.id))
      .limit(1)

    const [bookingCounts] = await tx
      .select({
        total: sql<string>`count(*)`,
        upcoming: sql<string>`count(*) filter (where ${bookings.status} in ('confirmed','checked_in'))`,
      })
      .from(bookings)

    // Balances are always DERIVED from the append-only ledgers — the same rule
    // lib/customers/ledger.ts states for the staff-facing profile. There is no
    // balance column anywhere, and the portal must not invent one.
    const [wallet] = await tx
      .select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)` })
      .from(walletTransactions)

    const [loyalty] = await tx
      .select({ total: sql<string>`coalesce(sum(${loyaltyTransactions.points}), 0)` })
      .from(loyaltyTransactions)

    const [membership] = await tx
      .select({
        planName: customerMemberships.planName,
        expiresAt: customerMemberships.expiresAt,
        discountPercent: customerMemberships.discountPercent,
      })
      .from(customerMemberships)
      .where(
        and(
          eq(customerMemberships.status, 'active'),
          gt(customerMemberships.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(customerMemberships.expiresAt))
      .limit(1)

    const recentBookings = await tx
      .select({
        id: bookings.id,
        bookingNumber: bookings.bookingNumber,
        status: bookings.status,
        total: bookings.total,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .orderBy(desc(bookings.createdAt))
      .limit(RECENT_LIMIT)

    return {
      // RLS guarantees this row is the session's customer, but a missing row
      // would mean the customer was deleted mid-session; fall back to the
      // session's own copy rather than crashing the page.
      account: account ?? {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
      totalBookings: Number(bookingCounts?.total ?? 0),
      upcomingBookings: Number(bookingCounts?.upcoming ?? 0),
      walletBalance: Number(wallet?.total ?? 0),
      loyaltyPoints: Number(loyalty?.total ?? 0),
      membership: membership ?? null,
      recentBookings,
    }
  })
}
