import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { withCustomer } from '@/db'
import { customers } from '@/db/schema'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { normalizeGoogleReviewUrl } from '@/lib/settings/google-review'

/**
 * THE Google review prompt decision, made once, on the server (0104).
 *
 * Every condition the prompt depends on is answered here, so the client
 * component receives a URL or null and has no judgement of its own to make.
 * That is deliberate: a browser must not be the thing deciding whether a
 * customer is eligible, and duplicating the rule across the pages a customer
 * can enter the portal from is how the two copies drift.
 *
 * ── The four questions, in the order they are cheapest to answer ────────────
 *
 *   1. Has this customer already answered?      customers.google_review_…
 *   2. Has the venue enabled a link?            public_google_review()
 *   3. Is the stored link still valid?          normalizeGoogleReviewUrl()
 *   4. Is the customer eligible?                a successful booking or order
 *
 * Any "no" returns null and the portal renders nothing. The customer's own
 * answer is checked FIRST because it is a column on a row already being read,
 * and because a customer who has finished should not cost the venue a
 * capability lookup on every visit.
 *
 * ── ELIGIBILITY IS DERIVED, NEVER STORED ───────────────────────────────────
 *
 * "Has a successful booking or order" is a question `bookings` and `orders`
 * already answer. Deriving it rather than maintaining an `eligible` flag is
 * what lets this feature touch neither the booking flow nor the order flow —
 * and it is also why five bookings cannot produce five prompts: there is no
 * per-booking row to produce them from. One customer, one question, one answer.
 *
 * A cancelled booking or a rejected order stops counting the moment it changes,
 * with no reconciliation job, because nothing was copied.
 *
 * ── What counts as SUCCESSFUL ──────────────────────────────────────────────
 *
 * BOOKINGS: confirmed, checked_in or completed. Not `cancelled`, not
 * `no_show` — someone who never turned up has no experience to rate.
 * `completed` is included even though ACTIVE_BOOKING_STATUSES omits it: that
 * constant answers "is this booking live right now", which is a different
 * question from "did this customer have a session".
 *
 * ORDERS: accepted, and not cancelled. `acceptance_status` is the gate a human
 * or a payment passed (lib/orders/public-status.ts), so `pending` (nobody has
 * accepted it yet), `rejected` and `awaiting_payment` are all excluded — an
 * abandoned cart never reaches `accepted` at all.
 */

export type ReviewPrompt = {
  /** Validated, canonical, safe to put in an href. */
  url: string
  /** Names the venue in the copy, so the ask reads as the venue's, not ours. */
  venueName: string
}


/**
 * Whether to show the prompt to the CURRENT customer, and with what link.
 *
 * Identity comes from the session via requireCustomer() and the transaction is
 * opened with withCustomer(), so RLS scopes every row — the same reader rule
 * lib/portal/account.ts states. No tenant id, customer id or booking id from
 * the browser is used as an authorisation anywhere below.
 */
export async function getReviewPrompt(venueName: string): Promise<ReviewPrompt | null> {
  const customer = await requireCustomer()

  return withCustomer(customer.id, async (tx) => {
    // 1. Already answered? Read from the customer's own row, which
    //    customers_customer_isolation (0045) confines to this customer.
    const [me] = await tx
      .select({ done: customers.googleReviewPromptCompletedAt })
      .from(customers)
      .where(eq(customers.id, customer.id))
      .limit(1)
    if (!me || me.done !== null) return null

    // 2 + 3. The venue's link. The function returns null when the owner has not
    //    enabled it; normalize re-validates because this value's next stop is
    //    an href in a customer's browser, and a row written before the 0104
    //    CHECK existed must not be able to send anybody off-Google.
    const { rows } = await tx.execute<{ url: string | null }>(
      sql`select public.public_google_review(${customer.tenantId}::uuid) as url`,
    )
    const url = normalizeGoogleReviewUrl(rows[0]?.url ?? null)
    if (!url) return null

    // 4. Eligibility, through customer_review_eligible() (0104).
    //
    //    NOT a query from here: a customer session has no policy on `orders`
    //    at all — only staff and the public tenant GUC do — so an EXISTS
    //    written in this file would silently answer "no" for every customer
    //    who had only ordered food. The function reads past RLS by design,
    //    confines itself to current_customer_id()'s own rows, and returns one
    //    boolean, so no booking or order detail crosses the boundary.
    const { rows: elig } = await tx.execute<{ yes: boolean }>(
      sql`select public.customer_review_eligible() as yes`,
    )
    if (!elig[0]?.yes) return null
    return { url, venueName }
  })
}

/**
 * Record that the customer said they left a review.
 *
 * ── This is NOT "Google confirmed a review" ────────────────────────────────
 *
 * Nothing in this flow can know that. The customer is taken to Google by a
 * one-way link; there is no callback, no postMessage, and the Business Profile
 * API's reviews.list is per LOCATION and carries a reviewer display name rather
 * than an Arena OS customer id, so even a fully connected tenant could not
 * attribute a review to the person who clicked.
 *
 * So this is the customer's own statement, and the column name says so. It is
 * reached only from an explicit "I've left my review" action — never from the
 * click that opens Google, which would turn "opened a tab" into a permanent
 * claim that they reviewed.
 *
 * Idempotent: the `is null` predicate means a double-click or a replayed action
 * keeps the FIRST answer's timestamp rather than moving it.
 */
export async function markReviewPromptCompleted(): Promise<boolean> {
  const customer = await requireCustomer()
  return withCustomer(customer.id, async (tx) => {
    // customer_complete_review_prompt() (0104), not an UPDATE from here: a
    // customer session has no permissive UPDATE policy on `customers` —
    // customers_customer_isolation is RESTRICTIVE, which narrows and never
    // grants — so a direct write silently affects nothing. The function names
    // the one column it may touch, which is column-level restriction RLS
    // cannot express, and is the same device customer_update_profile() (0048)
    // uses for name and the opt-ins.
    //
    // False means the prompt was already answered, which is not an error.
    const { rows } = await tx.execute<{ ok: boolean }>(
      sql`select public.customer_complete_review_prompt() as ok`,
    )
    return rows[0]?.ok === true
  })
}
