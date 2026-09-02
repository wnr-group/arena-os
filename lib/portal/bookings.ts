import 'server-only'
import { asc, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { withCustomer, type DB } from '@/db'
import { bookings, bookingSlots } from '@/db/schema'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { getCancellationPolicy, type CancellationPolicy } from './cancel'

/**
 * The customer's own booking history (AROS-89).
 *
 * Follows the reader rule stated in lib/portal/account.ts: identity comes from
 * the SESSION via requireCustomer(), the transaction is opened with
 * withCustomer(), and RLS (0045 + 0046) does the scoping. No booking id, tenant
 * id or customer id supplied by the browser is ever used as an authorisation.
 *
 * ── Why the queries look like this ──────────────────────────────────────────
 *
 * A booking is a header row plus one or more booking_slots — a reservation can
 * cover several resources, or one resource across several windows. What a
 * customer wants is one line per BOOKING with the span it occupies, so the
 * slots are aggregated: min(starts_at) is when it begins, max(ends_at) is when
 * it ends, and the resource names collapse to a distinct list.
 *
 * The join is LEFT so a booking with no slots still appears. That should not
 * happen (createBookingCore always writes at least one), but a customer's own
 * history is the last place that should silently drop a row.
 *
 * resource_name / resource_type_name are read straight off booking_slots, which
 * denormalised them at booking time (0003). There is deliberately no join to
 * `resources`: renaming a bay must not rewrite what a past booking says, and
 * the live catalogue is not customer-readable at all.
 *
 * `total` is the STORED bookings.total. It is never recomputed from current
 * rates — a past booking's price is a historical fact, and lib/booking/service.ts
 * is the only thing that ever writes it.
 *
 * ── A driver detail worth stating, because it bites silently ────────────────
 *
 * The aggregates go through Drizzle's query builder with .mapWith(), NOT
 * through tx.execute(sql`…`). Drizzle's raw execute() hands back whatever
 * node-postgres produced without applying its column mappers, and for
 * timestamptz that is a STRING ('2026-08-24 08:42:54.286496+00'), not a Date.
 * A string is truthy, so a null-check waves it through, and it only explodes
 * later inside Intl with "RangeError: Invalid time value" — and only for
 * customers who actually have bookings, which is exactly the case an
 * empty-state test does not cover. .mapWith(bookingSlots.startsAt) applies the
 * same mapper a plain column select would, so these come back as real Dates.
 */

export type PortalBookingSummary = {
  id: string
  bookingNumber: string
  status: string
  total: string
  /** Null only for the pathological no-slot booking. */
  startsAt: Date | null
  endsAt: Date | null
  resourceNames: string[]
  createdAt: Date
  /**
   * Whether the Cancel control should appear (AROS-90). A cheap SQL-side
   * approximation — status plus the cutoff — deliberately NOT the whole rule:
   * the authoritative check runs again inside the action, where the open-order
   * and deposit facts are available. This only decides what to render.
   */
  canCancel: boolean
  /**
   * The venue is holding a deposit, so cancelling sends it to staff rather
   * than refunding it. Read straight off the customer's own booking row; the
   * action re-derives it authoritatively (it also counts a settled gateway
   * intent, which is not visible from here).
   */
  hasDeposit: boolean
  /** Raised by a customer cancellation that left money with the venue. */
  depositReviewRequired: boolean
}

export type PortalBookingSlot = {
  resourceName: string
  resourceTypeName: string
  startsAt: Date
  endsAt: Date
}

export type PortalBookingDetail = PortalBookingSummary & {
  /** The venue's cancellation rule, so the detail page can state it. */
  policy: CancellationPolicy
  notes: string | null
  subtotal: string
  discount: string
  tax: string
  deposit: string
  source: string
  /** The unguessable key for the shareable confirmation page + its QR code. */
  confirmationToken: string
  slots: PortalBookingSlot[]
}

export type PortalBookingLists = {
  /** The requested page of upcoming bookings — NOT the whole list. */
  upcoming: PortalBookingSummary[]
  /** The requested page of history — NOT the whole list. */
  past: PortalBookingSummary[]
  /** Where each list above sits in its full set, so the UI can page through. */
  pagination: { upcoming: PortalPageInfo; past: PortalPageInfo }
  /** The venue's rule, so the UI can state it before asking anyone to confirm. */
  policy: CancellationPolicy
}

/**
 * Where one rendered page sits within its full list.
 *
 * `total` is the size of the WHOLE list, not of the page — the section heading
 * shows it, so a customer with 200 bookings sees "200" and not "10".
 */
export type PortalPageInfo = {
  /** 1-based, and already clamped into [1, pageCount]. */
  page: number
  pageSize: number
  /** Rows in the entire list. */
  total: number
  /** At least 1, so "page 1 of 1" is what an empty list reads. */
  pageCount: number
}

/** Which page of each list to read. Absent, invalid or out-of-range → page 1. */
export type PortalBookingPages = { upcoming?: number; past?: number }

/**
 * Rows per page, per section.
 *
 * Both lists are paged, for different reasons. `past` grows without bound —
 * every booking a customer ever made stays in it forever, each carrying an
 * array_agg of its resource names — so an unbounded read gets slower for
 * exactly the loyal customers a venue can least afford to annoy. `upcoming` is
 * naturally smaller, but nothing stops somebody block-booking fifty slots, and
 * a section that silently grew to fifty rows would bury the cancel button for
 * the booking they actually came to find.
 *
 * Ten keeps both sections glanceable on a phone, which is where a portal is
 * mostly read.
 */
export const BOOKINGS_PAGE_SIZE = 10

/**
 * A customer-scoped transaction, as produced by withCustomer(). Holding one is
 * what proves the caller is already inside the right RLS context.
 */
export type PortalTx = DB

/**
 * Statuses that can still be ahead of you. Everything else is history.
 *
 * Exported for the same reason as bookingEndInstant below: the overview's
 * "Upcoming bookings" count must classify a booking exactly as this page does,
 * and the only way to guarantee that is for both to read the one list.
 */
export const LIVE_STATUSES = ['confirmed', 'checked_in'] as const

/**
 * The aggregate columns shared by both listings and the detail read.
 *
 * `filter (where … is not null)` keeps the LEFT JOIN's null row out of the
 * array, so a slotless booking yields '{}' rather than '{NULL}'.
 */
function summaryColumns(policy: CancellationPolicy) {
  return {
    id: bookings.id,
    bookingNumber: bookings.bookingNumber,
    status: bookings.status,
    total: bookings.total,
    createdAt: bookings.createdAt,
    startsAt: sql<Date | null>`min(${bookingSlots.startsAt})`.mapWith(bookingSlots.startsAt),
    endsAt: sql<Date | null>`max(${bookingSlots.endsAt})`.mapWith(bookingSlots.endsAt),
    resourceNames: sql<string[]>`coalesce(
      array_agg(distinct ${bookingSlots.resourceName}) filter (where ${bookingSlots.id} is not null),
      '{}'
    )`,
    hasDeposit: sql<boolean>`${bookings.deposit} > 0`,
    depositReviewRequired: bookings.depositReviewRequired,
    /**
     * Cancellable, as far as this query can tell.
     *
     * Both comparisons are between absolute instants against the DATABASE
     * clock — min(starts_at) is timestamptz and so is now() — so no timezone
     * arithmetic is involved and an overnight booking is judged on its start
     * instant rather than a calendar date. `coalesce(…, false)` makes the
     * slotless booking uncancellable online, which is the safe direction.
     */
    canCancel: policy.enabled
      ? sql<boolean>`(
          ${bookings.status} = 'confirmed'
          and coalesce(
            min(${bookingSlots.startsAt}) - now() >= make_interval(hours => ${policy.cutoffHours}),
            false
          )
        )`
      : sql<boolean>`false`,
  }
}

/**
 * "Has this booking finished?" as a SQL expression.
 *
 * Tests max(ends_at), not starts_at: a booking happening RIGHT NOW is still
 * upcoming as far as the customer is concerned, and an overnight slot that
 * began yesterday and runs to 2am has not become history at midnight.
 *
 * coalesce(..., created_at) gives the slotless booking a defined answer instead
 * of dropping it from both lists on a NULL comparison.
 *
 * `now()` is the DATABASE clock, and both sides are timestamptz — absolute
 * instants. No timezone arithmetic happens here at all; the venue's zone is
 * used only for DISPLAY, in the components.
 */
/**
 * The instant a booking is treated as having ended.
 *
 * Exported because the portal OVERVIEW counts the same thing this page lists,
 * and the two disagreeing is exactly the bug that made this a shared constant:
 * lib/portal/account.ts used to count "upcoming" from status alone, so a
 * confirmed booking whose slot ended yesterday and was never marked completed
 * was counted as upcoming on the overview while appearing under Past here. At
 * the end of a busy day the overview claimed upcoming bookings the list showed
 * none of.
 *
 * Only usable in a GROUPED context — it aggregates with max(). See
 * lib/portal/account.ts for how the count reuses it.
 */
export const bookingEndInstant = sql`coalesce(max(${bookingSlots.endsAt}), ${bookings.createdAt})`

const finished = sql`${bookingEndInstant} <= now()`
export const notFinished = sql`${bookingEndInstant} > now()`

/**
 * Both sections, in one customer-scoped transaction.
 *
 * ── Upcoming vs past ────────────────────────────────────────────────────────
 *
 * The ticket describes upcoming as "future + confirmed/checked_in" and past as
 * "completed/cancelled". Taken literally those two sets do not cover the
 * booking_status enum, and a booking falling through the gap would vanish from
 * the customer's history. Two cases do fall through:
 *
 *   * 'no_show' — a real status (0003) the ticket does not mention;
 *   * a 'confirmed' or 'checked_in' booking whose time has already passed,
 *     because staff never got round to marking it completed. In a live venue
 *     that is the common case by the end of any given day.
 *
 * So the rule implemented here is exhaustive rather than literal:
 *
 *   UPCOMING = status in (confirmed, checked_in) AND not finished yet
 *   PAST     = everything else
 *
 * Every booking lands in exactly one section, which is the property that
 * actually matters to someone hunting for their receipt.
 *
 * Two queries rather than one classified in JavaScript: each section has its
 * own filter AND its own sort order (soonest first vs. most recent first), so
 * both stay the database's job. Neither query is given a customer id — RLS has
 * already reduced `bookings` to this customer's rows, which is precisely why an
 * unqualified `from bookings` is a correct "my bookings" here.
 */
export async function getPortalBookings(pages: PortalBookingPages = {}): Promise<PortalBookingLists> {
  const customer = await requireCustomer()
  return withCustomer(customer.id, (tx) => readPortalBookings(tx, customer.tenantId, pages))
}

/**
 * The reader itself, over an ALREADY customer-scoped transaction.
 *
 * Split out from getPortalBookings() so it can be driven from a plain Node
 * script — `cookies()` only exists inside a request, and the query is the part
 * worth testing. Note what it takes: a transaction, NOT a customer id. The tx
 * IS the authorisation (only withCustomer() produces a scoped one), so there is
 * no id here for a route param to be smuggled into.
 */
export async function readPortalBookings(
  tx: PortalTx,
  tenantId: string,
  pages: PortalBookingPages = {},
): Promise<PortalBookingLists> {
  // One policy read per page, then reused by both queries — the cutoff is part
  // of the SELECT, so it has to be known before either runs.
  const policy = await getCancellationPolicy(tx, tenantId)
  const cols = summaryColumns(policy)

  // The two classifications, named once. Both queries below and both counts
  // read these SAME expressions, so a page can never be counted by one rule and
  // listed by another — which would show "page 2 of 3" over an empty section.
  const upcomingHaving = notFinished
  const pastHaving = or(notInArray(bookings.status, [...LIVE_STATUSES]), finished)

  /**
   * How many bookings the section holds in total.
   *
   * Counted BEFORE the page is read, because the page number has to be clamped
   * against something: a hand-typed ?past=99 must land on the last real page
   * rather than an empty section that still claims there is more. A window
   * function (count(*) over ()) cannot do this — it rides along on result rows,
   * and an over-range page has none to carry it.
   *
   * The inner select is grouped per booking because both HAVING clauses
   * aggregate with max() over the slots; the outer aggregate then counts the
   * classified rows. Same shape as the overview's count in lib/portal/account.ts.
   */
  const countOf = async (where: SQL | undefined, having: SQL | undefined) => {
    const grouped = tx
      .select({ id: bookings.id })
      .from(bookings)
      .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
      .where(where)
      .groupBy(bookings.id)
      .having(having)
      .as('grouped')
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(grouped)
    return row?.n ?? 0
  }

  const upcomingTotal = await countOf(inArray(bookings.status, [...LIVE_STATUSES]), upcomingHaving)
  const pastTotal = await countOf(undefined, pastHaving)

  const upcomingPage = pageInfo(pages.upcoming, upcomingTotal)
  const pastPage = pageInfo(pages.past, pastTotal)

  const upcoming = await tx
    .select(cols)
    .from(bookings)
    .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
    .where(inArray(bookings.status, [...LIVE_STATUSES]))
    .groupBy(bookings.id)
    .having(upcomingHaving)
    // Soonest first: the next thing you are doing is the thing you came to see.
    .orderBy(sql`min(${bookingSlots.startsAt}) asc nulls last`, asc(bookings.createdAt))
    .limit(upcomingPage.pageSize)
    .offset((upcomingPage.page - 1) * upcomingPage.pageSize)

  const past = await tx
    .select(cols)
    .from(bookings)
    .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
    .groupBy(bookings.id)
    .having(pastHaving)
    // Most recent first: history is read backwards.
    .orderBy(sql`min(${bookingSlots.startsAt}) desc nulls last`, desc(bookings.createdAt))
    .limit(pastPage.pageSize)
    .offset((pastPage.page - 1) * pastPage.pageSize)

  return {
    upcoming: upcoming.map(normalise),
    past: past.map(normalise),
    pagination: { upcoming: upcomingPage, past: pastPage },
    policy,
  }
}

/**
 * Turn a requested page number into a real one.
 *
 * The input arrives from a query string, so it is anything at all: absent, a
 * word, 0, -3, 1e9, or a legitimate page that has since gone out of range
 * because bookings moved from Upcoming to Past between two visits. Every one of
 * those resolves to a page that exists rather than to an empty section, and the
 * CLAMPED number is what the UI renders — so the pager always describes the
 * page actually shown.
 *
 * pageCount is at least 1: an empty list reads "page 1 of 1", not "1 of 0".
 */
export function pageInfo(requested: unknown, total: number): PortalPageInfo {
  const pageCount = Math.max(1, Math.ceil(total / BOOKINGS_PAGE_SIZE))
  const asNumber = typeof requested === 'string' ? Number(requested) : requested
  const page =
    typeof asNumber === 'number' && Number.isInteger(asNumber) && asNumber >= 1
      ? Math.min(asNumber, pageCount)
      : 1
  return { page, pageSize: BOOKINGS_PAGE_SIZE, total, pageCount }
}

/** array_agg comes back as null rather than '{}' on some paths; pin it to []. */
function normalise<T extends { resourceNames: string[] | null }>(row: T) {
  return { ...row, resourceNames: row.resourceNames ?? [] }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One booking, by id — or null.
 *
 * The id comes from the URL, so it is treated as a LOOKUP KEY and never as
 * authorisation. Ownership is decided entirely by RLS: under withCustomer()
 * the `bookings` table contains only this customer's rows, so another
 * customer's booking id simply matches nothing here.
 *
 * Null covers "no such booking" and "not yours" identically, and the page turns
 * both into the same 404. Distinguishing them would confirm the existence of
 * another customer's booking to anyone willing to walk UUIDs.
 */
export async function getPortalBooking(bookingId: string): Promise<PortalBookingDetail | null> {
  const customer = await requireCustomer()
  return withCustomer(customer.id, (tx) => readPortalBooking(tx, customer.tenantId, bookingId))
}

/** The detail reader over an already customer-scoped transaction. See above. */
export async function readPortalBooking(
  tx: PortalTx,
  tenantId: string,
  bookingId: string,
): Promise<PortalBookingDetail | null> {
  // A malformed id must not reach Postgres as a uuid cast — that raises 22P02
  // and would turn a mistyped URL into a 500 instead of a 404.
  if (!UUID.test(bookingId)) return null

  const policy = await getCancellationPolicy(tx, tenantId)
  const cols = summaryColumns(policy)

  {
    const [row] = await tx
      .select({
        ...cols,
        notes: bookings.notes,
        subtotal: bookings.subtotal,
        discount: bookings.discount,
        tax: bookings.tax,
        deposit: bookings.deposit,
        source: bookings.source,
        confirmationToken: bookings.confirmationToken,
      })
      .from(bookings)
      .leftJoin(bookingSlots, eq(bookingSlots.bookingId, bookings.id))
      .where(eq(bookings.id, bookingId))
      .groupBy(bookings.id)
      .limit(1)

    if (!row) return null

    const slots = await tx
      .select({
        resourceName: bookingSlots.resourceName,
        resourceTypeName: bookingSlots.resourceTypeName,
        startsAt: bookingSlots.startsAt,
        endsAt: bookingSlots.endsAt,
      })
      .from(bookingSlots)
      .where(eq(bookingSlots.bookingId, bookingId))
      .orderBy(asc(bookingSlots.startsAt))

    return { ...normalise(row), slots, policy }
  }
}
