import 'server-only'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { BUSINESS_SCOPE } from './google-oauth'

/**
 * The consent-flow plumbing: where we send an owner, and how we trust what
 * comes back (0105).
 *
 * ══ THE STATE PARAMETER IS THE WHOLE SECURITY STORY ═════════════════════════
 *
 * A callback is an unauthenticated GET that anyone can hit with any `code`.
 * Without a bound `state`, an attacker could complete Google's flow with THEIR
 * OWN Google account and hand the resulting `code` to a signed-in owner — whose
 * browser would then attach that attacker's Business Profile to the victim's
 * venue. That is the classic OAuth login-CSRF, and `state` is the defence.
 *
 * The state here is:
 *
 *     <tenantId>.<nonce>.<hmac(tenantId.nonce)>
 *
 * signed with the app's existing master key. It is verified on the way back,
 * and the TENANT IS READ FROM THE SIGNED VALUE rather than from the request —
 * so a callback cannot name a tenant it was not issued for, whatever host it
 * arrives on. The nonce makes each attempt single-use in the cookie that pairs
 * with it.
 *
 * ── Why a signed value AND a cookie ────────────────────────────────────────
 *
 * The signature proves WE issued this state. The cookie proves it came back in
 * the SAME BROWSER that started the flow. Either alone is weaker: a signature
 * without a cookie can be replayed into someone else's browser, and a cookie
 * without a signature cannot tell us which tenant it was for.
 */

const STATE_TTL_MS = 10 * 60_000

/** The cookie that pairs with the signed state. Short-lived, httpOnly. */
export const OAUTH_STATE_COOKIE = 'g_oauth_state'

function secret(): Buffer {
  // Reuses the app's configured master key rather than introducing another —
  // one key to rotate, one place to get wrong.
  const raw = process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY
  if (!raw) throw new Error('PAYMENT_SETTINGS_ENCRYPTION_KEY is not set; cannot sign OAuth state.')
  return Buffer.from(raw, 'utf8')
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex')
}

/** A fresh state for one attempt. */
export function issueOAuthState(tenantId: string): string {
  const payload = `${tenantId}.${Date.now()}.${randomBytes(16).toString('hex')}`
  return `${payload}.${sign(payload)}`
}

/**
 * Verify a returned state, and recover the tenant it was issued for.
 *
 * Returns null for anything that does not verify — a bad signature, a mangled
 * shape, an expired attempt. Null is the only failure mode the caller needs,
 * because every one of them means the same thing: do not trust this callback.
 */
export function readOAuthState(state: string | null): { tenantId: string } | null {
  if (!state) return null
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [tenantId, issuedAt, nonce, mac] = parts

  const expected = sign(`${tenantId}.${issuedAt}.${nonce}`)
  // Constant-time: a fast-fail comparison leaks how much of a forged MAC was
  // right, which is enough to forge one a byte at a time.
  const a = Buffer.from(mac, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const age = Date.now() - Number(issuedAt)
  if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) return null

  return { tenantId }
}

/** Where Google sends the owner back. Must match the venue's OAuth client. */
export function callbackUrl(origin: string): string {
  return `${origin}/api/oauth/google-business/callback`
}

/**
 * Google's consent URL for one venue's own OAuth client.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * REFRESH token. Without both, a second authorisation returns only an access
 * token — and the connection would appear to succeed while storing nothing
 * usable, which is a particularly annoying bug to diagnose later.
 */
export function consentUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', BUSINESS_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', params.state)
  return url.toString()
}

/**
 * Exchange the one-time `code` for a refresh token.
 *
 * Separate from exchangeRefreshToken() in ./google-oauth: same endpoint, but a
 * different grant, different inputs, and a different failure meaning. Sharing
 * one function would have meant a union parameter and a branch, for no gain.
 */
export async function exchangeAuthCode(
  params: {
    code: string
    clientId: string
    clientSecret: string
    redirectUri: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string } | { error: string }> {
  let res: Response
  try {
    res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: params.code,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        redirect_uri: params.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return { error: `Could not reach Google: ${e instanceof Error ? e.name : 'unknown'}` }
  }

  const body = (await res.json().catch(() => ({}))) as {
    refresh_token?: string
    error?: string
    error_description?: string
  }

  if (!res.ok) {
    // The description names the failure, not the credential. The request body —
    // which carries the client secret and the code — is never echoed.
    return { error: body.error_description ?? body.error ?? `HTTP ${res.status}` }
  }

  if (!body.refresh_token) {
    // Google withholds it when the user has authorised before and the request
    // did not force re-consent. consentUrl() always sets prompt=consent, so
    // reaching here means something rewrote the URL.
    return {
      error:
        'Google returned no refresh token. Revoke this app under your Google account and authorise again.',
    }
  }

  return { refreshToken: body.refresh_token }
}
