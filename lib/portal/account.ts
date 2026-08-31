import 'server-only'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { withCustomer, type DB } from '@/db'
import { customers, bookings, bookingSlots, customerMemberships } from '@/db/schema'
import { walletBalance, loyaltyPoints } from '@/lib/customers/ledger'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { LIVE_STATUSES, notFinished } from './bookings'

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
  return withCustomer(customer.id, (tx) => readPortalSummary(tx, customer))
}

/**
 * The reads, over an ALREADY customer-scoped transaction.
 *
 * Split out for the same reason readPortalBookings() and readPortalWallet() are
 * — `cookies()` only exists inside a request, and the queries are the part worth
 * testing. This one was NOT split originally, and the consequence was a bug that
 * lived undetected: the upcoming count disagreed with the bookings page, and no
 * test could reach the query to notice. scripts/test-portal-bookings.ts now
 * asserts the two surfaces agree.
 *
 * Takes the session's customer rather than an id: the tx is the authorisation,
 * and the row is only used as a fallback if `customers` comes back empty.
 *
 * `tenantId` and `id` are read off it only to satisfy the shared ledger
 * helpers' existing signature — neither is trusted as authorisation. Both come
 * from the validated session, and RLS has already reduced every table here to
 * this customer's rows regardless. Same note as readPortalWallet().
 */
export async function readPortalSummary(
  tx: DB,
  customer: {
    id: string
    tenantId: string
    name: string | null
    phone: string
    email: string | null
  },
): Promise<PortalSummary> {
  {
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

    // ── the counts, classified EXACTLY as /account/bookings classifies ──────
    //
    // This used to be `count(*) filter (where status in ('confirmed','checked_in'))`
    // — status alone, with no time test — while the bookings page splits
    // upcoming from past on whether the booking has actually FINISHED. The two
    // disagreed for a real and common case: a confirmed booking whose slot ended
    // yesterday and that staff never marked completed counted as upcoming here
    // and appeared under Past there. By the end of a busy day the overview
    // advertised upcoming bookings the list showed none of.
    //
    // The fix is not a second copy of the time predicate — that is how the two
    // drifted in the first place. `LIVE_STATUSES` and `notFinished` are imported
    // from lib/portal/bookings.ts, so there is exactly one definition of
    // "upcoming" and both surfaces are answering the same question.
    //
    // The inner select is grouped per booking because notFinished aggregates
    // with max() over the slots — the same shape, and the same LEFT JOIN, the
    // listing uses. The outer aggregate then just counts the classified rows.
    const classified = tx
      .select({
        id: bookings.id,
        upcoming: sql<boolean>`(
          ${inArray(bookings.status, [...LIVE_STATUSES])} and ${notFinished}
        )`.as('upcoming'),
      })
      .from(bookings)
      .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
      .groupBy(bookings.id)
      .as('classified')

    const [bookingCounts] = await tx
      .select({
        total: sql<string>`count(*)`,
        upcoming: sql<string>`count(*) filter (where ${classified.upcoming})`,
      })
      .from(classified)

    // Balances are always DERIVED from the append-only ledgers — and derived by
    // CALLING lib/customers/ledger.ts, not by repeating its arithmetic here.
    // There is no balance column anywhere, and no second sum in this file: the
    // staff profile, the till and /account/wallet all go through these same two
    // helpers, so if either ever changes what it counts (excludes a
    // source_type, skips voided rows) this overview moves with them instead of
    // silently disagreeing with the counter. Same reasoning as
    // lib/portal/wallet.ts, which reads the identical pair.
    const balance = await walletBalance(tx, customer.tenantId, customer.id)
    const points = await loyaltyPoints(tx, customer.tenantId, customer.id)

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
      walletBalance: balance,
      loyaltyPoints: points,
      membership: membership ?? null,
      recentBookings,
    }
  }
}
