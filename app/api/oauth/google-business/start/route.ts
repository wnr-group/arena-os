import { NextResponse, type NextRequest } from 'next/server'
import { requireOwner } from '@/lib/auth/guard'
import { getGoogleConnectionStatus } from '@/lib/reviews/google-credentials'
import {
  consentUrl,
  issueOAuthState,
  callbackUrl,
  OAUTH_STATE_COOKIE,
} from '@/lib/reviews/google-oauth-flow'

/**
 * Step 1 of the consent flow: send a manager to Google (0106).
 *
 * A GET route rather than a server action, because the outcome is a
 * cross-origin REDIRECT and an action cannot produce one to a third party.
 *
 * ── Authorisation happens HERE, not on the way back ────────────────────────
 *
 * requireOwner() runs before anything else, so only the signed-in OWNER of this
 * venue can start a flow — and the tenant is taken from that session and sealed
 * into the state. The callback then trusts the SIGNED STATE rather than
 * re-deriving a tenant from a request it cannot authenticate.
 *
 * Owner rather than manager (0107): this is the entry point to the same
 * connection saveGoogleOAuthClientAction() writes, so a looser gate here would
 * have re-opened exactly the hole that tightened.
 *
 * ── The client id comes from the venue's own stored config ─────────────────
 *
 * There is no platform OAuth client. If the owner has not saved theirs yet,
 * there is nothing to send them to, so they are bounced back to settings rather
 * than to a Google error page that would not explain itself.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireOwner()

  const status = await getGoogleConnectionStatus(ctx.tenant.id)
  const settings = new URL('/settings/business', req.nextUrl.origin)
  if (!status?.clientId) {
    settings.searchParams.set('google', 'no_client')
    return NextResponse.redirect(settings)
  }

  // The origin of THIS request, so a venue on its own subdomain gets its own
  // callback URL — which is also the one it must register in its own OAuth
  // client. Deriving it rather than configuring it keeps the two in step.
  const redirectUri = callbackUrl(req.nextUrl.origin)
  const state = issueOAuthState(ctx.tenant.id)

  const res = NextResponse.redirect(
    consentUrl({ clientId: status.clientId, redirectUri, state }),
  )

  // The browser half of the CSRF pair. httpOnly so script cannot read it,
  // sameSite 'lax' because the callback arrives as a top-level navigation FROM
  // Google — 'strict' would drop the cookie exactly when it is needed.
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  })
  return res
}
