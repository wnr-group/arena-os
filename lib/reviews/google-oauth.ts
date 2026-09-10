import 'server-only'

/**
 * The Google OAuth token exchange — the PLATFORM's half of the connection.
 *
 * Two different secrets meet in this feature and must not be confused:
 *
 *   the OAUTH CLIENT (here)      Arena OS's own application registration.
 *                                ONE pair for the whole platform, from the
 *                                environment, never per tenant.
 *   the REFRESH TOKEN (per       What one venue's owner granted to that
 *   tenant, google-credentials)  application. Encrypted per tenant.
 *
 * A refresh token is worthless without the client secret and vice versa, which
 * is why they live in different places with different lifetimes.
 *
 * ── Why the client pair is PER TENANT and not an env var ──────────────────
 *
 * Because quota and verification are both per CLOUD PROJECT. A single
 * platform client would split ~300 QPM across every venue, and would need
 * Google's harder multi-tenant review for a sensitive scope. A venue using
 * its own project gets its own ceiling and can authorise its own account.
 *
 * So nothing here reads process.env: both halves arrive as arguments, from
 * the tenant's own encrypted row. That also makes this function testable
 * without setting environment variables.
 */

export class GoogleOAuthError extends Error {
  /** True when the grant is dead — a revoked token, or a disconnected app. */
  readonly permanent: boolean
  constructor(message: string, permanent: boolean) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.permanent = permanent
  }
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** The scope this feature needs, and the reason consent must be verified. */
export const BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage'

/**
 * Exchange a tenant's refresh token for a short-lived access token.
 *
 * ── Nothing here is cached ─────────────────────────────────────────────────
 *
 * An access token lives about an hour, and the sync runs on a schedule rather
 * than per request, so caching one would mean storing a value that is usually
 * stale by the time it is read, for a saving of one HTTP call per tenant per
 * run. Not worth the extra place a credential can sit.
 *
 * ── The error distinction that matters ─────────────────────────────────────
 *
 * `invalid_grant` means the owner revoked access, changed their Google
 * password, or the token expired from disuse. It will NEVER succeed on retry,
 * so it is marked permanent and the sync records it for a human — retrying it
 * hourly forever would just bury the real message. Everything else (a 5xx, a
 * network blip, a quota trip) is transient and worth another run.
 */
export async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError(
      'This venue has no Google OAuth client configured, so no token can be exchanged.',
      true,
    )
  }

  let res: Response
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      // Google is not allowed to hold a scheduled job open indefinitely.
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new GoogleOAuthError(
      `Could not reach Google's token endpoint: ${e instanceof Error ? e.name : 'unknown'}`,
      false,
    )
  }
  if (!res.ok) {
    // Google returns {error, error_description}. The DESCRIPTION is safe to
    // surface — it names the failure, not the credential. The request body,
    // which contains the secret and the refresh token, is never echoed.
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      error_description?: string
    }
    const code = body.error ?? `http_${res.status}`
    throw new GoogleOAuthError(
      `${code}${body.error_description ? `: ${body.error_description}` : ''}`,
      code === 'invalid_grant' || code === 'invalid_client' || res.status === 400,
    )
  }

  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) {
    throw new GoogleOAuthError('Google returned no access_token.', false)
  }
  return json.access_token
}
