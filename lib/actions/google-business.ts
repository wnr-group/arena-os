'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage } from '@/lib/utils/errors'
import { saveGoogleOAuthClient, deleteGoogleConnection } from '@/lib/reviews/google-credentials'

type Result = { error?: string; success?: true }

/**
 * Connect or disconnect a venue's Google Business Profile (0105).
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
 * requireManager() first, then the write runs inside withUser() so
 * `google_business_credentials_rw` (0105) is the second gate — the same two
 * layers every settings action uses. Nothing about identity or tenant comes
 * from the browser: `tenant_id` is taken from the authenticated context.
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
    const ctx = await requireManager()
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
    const ctx = await requireManager()
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
