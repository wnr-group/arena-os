'use server'

import { revalidatePath } from 'next/cache'
import { markReviewPromptCompleted } from '@/lib/portal/review-prompt'

type Result = { error?: string }

/**
 * The customer's own statement that they have left a Google review (0105).
 *
 * ── What this action does NOT mean ─────────────────────────────────────────
 *
 * It is not confirmation from Google. There is no per-customer submission
 * signal for a review-link flow — no callback, no postMessage — and the
 * Business Profile API's reviews.list is per LOCATION and returns a reviewer
 * display name rather than an Arena OS customer id, so even a fully connected
 * tenant could not attribute a review to the person who clicked. This records
 * what the customer told us, which is the only honest thing available.
 *
 * That is also why it is a SEPARATE action from opening the link. Treating the
 * click as completion would turn "opened a tab" into a permanent claim that
 * they reviewed, and would silence the prompt for people who never got there.
 *
 * ── Authorisation ──────────────────────────────────────────────────────────
 *
 * A server action is a public POST endpoint, so the identity cannot come from
 * the caller. markReviewPromptCompleted() resolves the customer from the
 * session via requireCustomer() and writes inside withCustomer(), where
 * customers_customer_isolation (0045) confines the UPDATE to that customer's
 * own row. There is no parameter here at all — nothing to tamper with.
 */
export async function confirmGoogleReviewLeft(): Promise<Result> {
  try {
    await markReviewPromptCompleted()
    // The prompt lives in the portal layout, so every portal route's cached
    // render still believes it is pending until this clears them.
    revalidatePath('/account', 'layout')
    return {}
  } catch (e) {
    // requireCustomer() signals "not signed in" with redirect(), which throws a
    // Next CONTROL-FLOW error rather than a normal one. Swallowing it here
    // would turn an expired session into a silent no-op instead of a trip to
    // the login page, so it is re-thrown before anything else is considered.
    if (e && typeof e === 'object' && 'digest' in e) throw e
    console.error('[customer-review] confirm failed:', e)
    return { error: 'Could not save that. Please try again.' }
  }
}
