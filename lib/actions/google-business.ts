'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireOwner, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage } from '@/lib/utils/errors'
import { saveGoogleOAuthClient, deleteGoogleConnection } from '@/lib/reviews/google-credentials'
import { syncGoogleReviewsForTenant } from '@/lib/reviews/sync'
import { createGoogleReviewFetcher } from '@/lib/reviews/google-business-api'

type Result = { error?: string; success?: true }

/**
 * Connect or disconnect a venue's Google Business Profile (0106).
 *
 * ── Why the venue supplies its own OAuth client ────────────────────────────
 *
 * Quota and app verification are both per Google Cloud PROJECT. One shared
 * Arena OS client would split ~300 QPM across every venue and would need
 * Google's harder multi-tenant review for the sensitive `business.manage`
 * scope. A venue bringing its own project gets its own ceiling, its own
 * verification, and its own blast radius.
 *
 * The cost is honest and belongs in the UI, not hidden: the owner has to create
 * a Cloud project, enable the Business Profile API, and make an OAuth client
 * before this form can be filled in.
 *
 * ── Authorisation ──────────────────────────────────────────────────────────
 *
 * requireOwner() first, then the write runs inside withUser() so
 * `google_business_credentials_rw` (0106, tightened 0107) is the second gate —
 * the same two layers every settings action uses. Nothing about identity or
 * tenant comes from the browser: `tenant_id` is taken from the authenticated
 * context.
 *
 * OWNER, not manager (0107). This used to be requireManager() while the only
 * screen that reaches it — /settings/business — redirects anybody who is not
 * the owner. A server action is a public POST endpoint, so that gap let a
 * manager who could not SEE the form still call it: binding their own Google
 * Business Profile to the venue, or disconnecting the owner's. Resolved towards
 * the stricter of the two, matching business_profiles, which holds the very
 * settings this sits beside and has been owner-only since 0020 — connecting an
 * external identity to the business belongs with its legal identity.
 *
 * The client secret and refresh token are encrypted before they reach the
 * database (lib/reviews/google-credentials.ts) with the tenant id as AAD, and
 * neither is ever read back into a page — getGoogleConnectionStatus() exists
 * precisely so a settings screen can show the connection without them.
 */

const connectionInput = z.object({
  // Google's console shows `accounts/123`; its API returns a bare `123`. Both
  // are accepted and normalised when the request is built, so an owner pasting
  // from either place gets a working connection rather than a confusing 404.
  accountId: z.string().trim().min(1, 'Enter your Google account id.').max(200),
  locationId: z.string().trim().min(1, 'Enter your Google location id.').max(200),
  clientId: z.string().trim().min(1, 'Enter your OAuth client id.').max(300),
  clientSecret: z.string().trim().min(1, 'Enter your OAuth client secret.').max(300),

})

export async function saveGoogleOAuthClientAction(
  input: z.input<typeof connectionInput>,
): Promise<Result> {
  try {
    const ctx = await requireOwner()
    const v = connectionInput.parse(input)

    await withUser(ctx.user.id, (tx) => saveGoogleOAuthClient(ctx.tenant.id, v, tx))

    revalidatePath('/settings/business')
    return { success: true }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Forget the connection.
 *
 * The CACHED REVIEWS are deliberately kept — disconnecting means "stop
 * syncing", not "erase what the homepage already shows" — so a venue that
 * reconnects does not have a page that goes blank in between. Deleting them is
 * a separate, explicit act.
 */
export async function disconnectGoogleBusiness(): Promise<Result> {
  try {
    const ctx = await requireOwner()
    await withUser(ctx.user.id, (tx) => deleteGoogleConnection(ctx.tenant.id, tx))
    revalidatePath('/settings/business')
    return { success: true }
  } catch (e) {
    return fail(e)
  }
}

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  // Never echo the exception: it may carry a token or a client secret from a
  // failed encryption or a driver error quoting the statement.
  console.error('[google-business] save failed:', e instanceof Error ? e.name : 'unknown')
  return { error: 'Could not save the Google connection. Please try again.' }
}

/**
 * Pull this venue's reviews from Google right now (0107).
 *
 * ── Why a button was needed ────────────────────────────────────────────────
 *
 * The only thing that filled the cache was a cron job nobody had installed:
 * syncAllGoogleReviews() was referenced by the runner script and the tests and
 * by nothing else, so a venue could finish the consent flow, see "Connected",
 * and watch its homepage stay empty forever with no way to tell whether the
 * connection or the schedule was at fault.
 *
 * This gives the owner an answer in one click, and makes the first sync part of
 * connecting rather than something that silently happens later — or never.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * ONE tenant, the caller's own, taken from the authenticated context. It is not
 * the sweep: a settings screen must never be able to start platform-wide work,
 * and the sweep's serialisation belongs to the cron process that owns its own
 * connection (see scripts/sync-google-reviews.ts).
 *
 * Racing the cron is harmless — the unique constraint plus ON CONFLICT DO
 * UPDATE means the worst case is the same rows written twice.
 *
 * Runs on the OWNER database connection inside syncGoogleReviewsForTenant, not
 * withUser(), because it reads the encrypted refresh token — which is exactly
 * why this action is owner-gated and takes no parameters.
 */
export async function syncGoogleReviewsNow(): Promise<
  Result & { synced?: number; skipped?: number }
> {
  try {
    const ctx = await requireOwner()
    const r = await syncGoogleReviewsForTenant(ctx.tenant.id, createGoogleReviewFetcher())

    revalidatePath('/settings/business')
    if (!r.connected) {
      return { error: 'Authorise with Google before syncing.' }
    }
    // The sync records its own failure in last_sync_error; this surfaces the
    // same message immediately rather than making the owner reload to find it.
    if (r.error) return { error: r.error }
    return { success: true, synced: r.synced, skipped: r.skipped }
  } catch (e) {
    return fail(e)
  }
}
