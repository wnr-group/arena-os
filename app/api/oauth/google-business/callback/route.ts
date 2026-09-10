import { NextResponse, type NextRequest } from 'next/server'
import { ownerDb } from '@/db'
import { saveGoogleRefreshToken } from '@/lib/reviews/google-credentials'
import {
  exchangeAuthCode,
  readOAuthState,
  callbackUrl,
  OAUTH_STATE_COOKIE,
} from '@/lib/reviews/google-oauth-flow'
import { decryptSecret } from '@/lib/security/encryption'
import { googleBusinessCredentials } from '@/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Step 2: Google sends the owner back here with a one-time code (0105).
 *
 * ══ THIS ROUTE CANNOT AUTHENTICATE ITS CALLER ═══════════════════════════════
 *
 * It is a plain GET that anybody can hit with any query string, and the browser
 * arriving may or may not carry a staff session. So NOTHING here is trusted
 * from the request except by way of two things that must BOTH hold:
 *
 *   1. the `state` verifies against our own HMAC, and the tenant is read OUT of
 *      that signed value — never from a parameter or the host;
 *   2. the same state is present in an httpOnly cookie, proving the flow
 *      finished in the browser that started it.
 *
 * Without (1) an attacker could name any tenant. Without (2) they could
 * complete Google's flow with their OWN account and hand the resulting URL to a
 * venue owner, attaching the attacker's Business Profile to the victim's venue.
 * That is login-CSRF, and it is the specific attack this pair prevents.
 *
 * Note what is deliberately NOT here: requireManager(). A redirect back from
 * Google is not a place to demand a session — the owner may have been bounced
 * through an account chooser — so the signed state carries the authorisation
 * that requireManager() established in /start.
 */
export async function GET(req: NextRequest) {
  const settings = new URL('/settings/business', req.nextUrl.origin)
  const fail = (reason: string) => {
    settings.searchParams.set('google', reason)
    const res = NextResponse.redirect(settings)
    res.cookies.delete(OAUTH_STATE_COOKIE)
    return res
  }

  // The owner pressed Cancel on Google's consent screen. Not an error.
  if (req.nextUrl.searchParams.get('error')) return fail('cancelled')

  const returned = req.nextUrl.searchParams.get('state')
  const cookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null
  // Both halves, and they must be the same value. A missing cookie is as fatal
  // as a bad signature: it means this callback finished somewhere else.
  if (!returned || !cookie || returned !== cookie) return fail('bad_state')

  const verified = readOAuthState(returned)
  if (!verified) return fail('bad_state')

  const code = req.nextUrl.searchParams.get('code')
  if (!code) return fail('no_code')

  // The tenant comes from the SIGNED state. Everything below is scoped to it.
  const tenantId = verified.tenantId

  // The client pair, read directly rather than through loadGoogleConnection():
  // that helper returns null until a refresh token exists, and at this exact
  // moment there is none — obtaining one is the point of this request.
  const [row] = await ownerDb
    .select({
      clientId: googleBusinessCredentials.oauthClientId,
      clientSecretCiphertext: googleBusinessCredentials.oauthClientSecretEncrypted,
    })
    .from(googleBusinessCredentials)
    .where(eq(googleBusinessCredentials.tenantId, tenantId))
    .limit(1)
  if (!row) return fail('no_client')

  let clientSecret: string
  try {
    clientSecret = decryptSecret(row.clientSecretCiphertext, tenantId)
  } catch {
    // The master key changed or the row was tampered with. A real fault, and
    // not one to describe to a browser.
    console.error(`[google-oauth] could not decrypt the client secret for tenant ${tenantId}`)
    return fail('decrypt_failed')
  }

  const exchanged = await exchangeAuthCode({
    code,
    clientId: row.clientId,
    clientSecret,
    // MUST be byte-identical to the one sent in /start — Google compares them.
    redirectUri: callbackUrl(req.nextUrl.origin),
  })

  if ('error' in exchanged) {
    // The message is Google's own description of the failure, never the code or
    // the secret. Logged for an operator; the browser gets a short reason.
    console.error(`[google-oauth] code exchange failed for tenant ${tenantId}: ${exchanged.error}`)
    return fail('exchange_failed')
  }

  const stored = await saveGoogleRefreshToken(tenantId, exchanged.refreshToken)
  if (!stored) return fail('no_client')

  settings.searchParams.set('google', 'connected')
  const res = NextResponse.redirect(settings)
  // Single-use: the state is spent whether or not this succeeded.
  res.cookies.delete(OAUTH_STATE_COOKIE)
  return res
}
