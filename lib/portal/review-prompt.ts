import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { withCustomer } from '@/db'
import { customers } from '@/db/schema'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { normalizeGoogleReviewUrl } from '@/lib/settings/google-review'

/**
 * THE Google review prompt decision, made once, on the server (0105).
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
 *   4. Is the customer eligible?                a finished visit — see below
 *
 * Any "no" returns null and the portal renders nothing. The customer's own
 * answer is checked FIRST because it is a column on a row already being read,
 * and because a customer who has finished should not cost the venue a
 * capability lookup on every visit.
 *
 * ── ELIGIBILITY IS DERIVED, NEVER STORED ───────────────────────────────────
 *
 * "Has this customer finished a visit" is a question `bookings`, `orders` and
 * `kots` already answer. Deriving it rather than maintaining an `eligible` flag
 * is what lets this feature touch neither the booking flow nor the order flow —
 * and it is also why five bookings cannot produce five prompts: there is no
 * per-booking row to produce them from. One customer, one question, one answer.
 *
 * A cancelled booking or a cancelled order stops counting the moment it
 * changes, with no reconciliation job, because nothing was copied.
 *
 * ── ONE RULE, EVERYWHERE IN THE PORTAL ─────────────────────────────────────
 *
 * The prompt is mounted once, by the portal layout, and asks the same question
 * on every portal page — /account, /account/bookings, /account/wallet and
 * /account/profile alike. There is deliberately no per-route variation: a
 * customer who is due the ask is due it wherever they happen to be, and a rule
 * that changed between tabs of the same portal reads as a bug rather than as a
 * design.
 *
 * ── What counts as a QUALIFYING EXPERIENCE (0108) ──────────────────────────
 *
 * EITHER of these — one finished experience is enough to have something to
 * review — but each now means something that actually ended:
 *
 *   BOOKING   status = 'completed'. Not `confirmed` and not `checked_in` —
 *             both of those mean the visit is still ahead of or during the
 *             customer, and `confirmed` is true from the instant a booking is
 *             created. Not `cancelled` or `no_show`: somebody who never turned
 *             up has no experience to rate.
 *
 *   FOOD      an `accepted`, non-cancelled order whose KITCHEN TICKET has been
 *             served. Delivery is not on the order: `orders.status` is the
 *             billing lifecycle (open / billed / cancelled) and has no
 *             fulfilment value at all. `kots.status = 'served'` is the moment
 *             food reached the customer, and is the same signal
 *             deriveCustomerOrderStatus() shows them in the portal.
 *
 * OR rather than AND, because a venue need not sell food at all: a recording
 * studio or a VR centre has no kitchen, so no KOT will ever exist for it and
 * requiring both would mean its customers could never be asked. Equally,
 * somebody who only ordered food still had an experience worth rating.
 *
 * Only the FOOD half moved in 0108. An `accepted` order used to qualify on its
 * own, but accepted only means somebody let the order exist — the food may
 * never have left the kitchen.
 *
 * The two are independent — `orders.booking_id` is nullable, so food ordered
 * without a booking token counts on its own.
 */

export type ReviewPrompt = {
  /** Validated, canonical, safe to put in an href. */
  url: string
  /** Names the venue in the copy, so the ask reads as the venue's, not ours. */
  venueName: string
  /**
   * Scopes the browser's "maybe later" memory to THIS customer (0107).
   *
   * The key used to be a constant, so two customers signing in from the same
   * browser tab shared one dismissal: the second was never asked. Not a
   * cross-tenant leak — subdomains are separate origins, so sessionStorage
   * cannot cross venues — but it did silence a prompt for the wrong person.
   * The WhatsApp countdown already scoped its key this way (per booking token).
   */
  customerId: string
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
    //    an href in a customer's browser, and a row written before the 0105
    //    CHECK existed must not be able to send anybody off-Google.
    const { rows } = await tx.execute<{ url: string | null }>(
      sql`select public.public_google_review(${customer.tenantId}::uuid) as url`,
    )
    const url = normalizeGoogleReviewUrl(rows[0]?.url ?? null)
    if (!url) return null

    // 4. Eligibility, through customer_review_eligible() (0105; its FOOD half
    //    tightened to "actually delivered" in 0108, booking half unchanged).
    //
    //    NOT a query from here: a customer session has no policy on `orders`
    //    or `kots` at all — only staff and the public tenant GUC do — so an
    //    EXISTS written in this file would silently answer "no" for every
    //    customer. The function reads past RLS by design, confines itself to
    //    the caller's own tenant and customer GUCs, and returns one boolean, so
    //    no booking or order detail crosses the boundary.
    //
    //    One round trip, two indexed EXISTS. Nothing is loaded and counted in
    //    application code, so a customer with a hundred orders costs the same
    //    as one with two.
    const { rows: elig } = await tx.execute<{ yes: boolean }>(
      sql`select public.customer_review_eligible() as yes`,
    )
    if (!elig[0]?.yes) return null
    return { url, venueName, customerId: customer.id }
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
    // customer_complete_review_prompt() (0105), not an UPDATE from here: a
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
