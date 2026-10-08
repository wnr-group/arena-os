import 'server-only'
import { eq } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { googleBusinessCredentials } from '@/db/schema'
import { decryptSecret, encryptSecret, DecryptionError } from '@/lib/security/encryption'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SERVER ONLY. The refresh token this returns must never reach a browser. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The one place a tenant's Google refresh token exists in plaintext.
 *
 * Its own file, exactly like lib/settings/razorpay-credentials.ts and for the
 * same reason: `grep -r google-credentials` enumerates every caller in the
 * project — an audit you can actually run. Nothing else may read the column.
 *
 * Rules for every caller:
 *   * never return `refreshToken` from a server action, route handler or RSC;
 *   * never log it, never put it in an error message, never serialise the
 *     object it lives in;
 *   * use it, then let it fall out of scope.
 *
 * ── Owner connection, deliberately ─────────────────────────────────────────
 *
 * The sync runs from a scheduled job with no user session, so there is no
 * `app.user_id` for RLS to match. Same narrow exception, and same containment,
 * as lib/payments/webhook.ts: every statement filters explicitly on tenantId,
 * and this module is the only door.
 *
 * The tenant id is ALSO the AAD the ciphertext was sealed with, so a row copied
 * between tenants fails to decrypt rather than quietly authorising as the wrong
 * venue — the same property lib/settings/razorpay-credentials.ts relies on.
 */

export type GoogleConnection = {
  accountId: string
  locationId: string
  /** The venue's OWN OAuth client id. Publishable, but scoped to them. */
  clientId: string
  /** SECRET. Server-side use only — never serialise this. */
  clientSecret: string
  /** SECRET. Server-side use only — never serialise this. */
  refreshToken: string
}

/** A tenant that has connected, minus the secret. Safe to show an owner. */
export type GoogleConnectionStatus = {
  accountId: string
  locationId: string
  /** Shown so an owner can confirm WHICH project is connected. Not a secret. */
  clientId: string
  /**
   * False when the client pair is saved but Google's consent flow has not
   * been completed. The two arrive at different times, and an owner needs to
   * see WHICH of the two steps is outstanding.
   */
  authorised: boolean
  connectedAt: Date
  lastSyncedAt: Date | null
  lastSyncError: string | null
}

/**
 * The tenant's connection, decrypted, or null when it has not connected.
 *
 * Null is a normal state — most tenants will never connect — so it is a return
 * value, not an error. A ciphertext that will not decrypt IS an error and is
 * thrown: it means the master key changed or the row was tampered with, and
 * silently treating that as "not connected" would hide a real fault behind a
 * homepage that merely looks empty.
 */
export async function loadGoogleConnection(
  tenantId: string,
  db: DB = ownerDb,
): Promise<GoogleConnection | null> {
  const [row] = await db
    .select({
      accountId: googleBusinessCredentials.googleAccountId,
      locationId: googleBusinessCredentials.googleLocationId,
      clientId: googleBusinessCredentials.oauthClientId,
      clientSecretCiphertext: googleBusinessCredentials.oauthClientSecretEncrypted,
      ciphertext: googleBusinessCredentials.refreshTokenEncrypted,
    })
    .from(googleBusinessCredentials)
    .where(eq(googleBusinessCredentials.tenantId, tenantId))
    .limit(1)

  if (!row) return null
  // Configured but not yet authorised. Indistinguishable from "not connected"
  // to every caller, because there is nothing either could do: the sync has
  // no token to exchange.
  if (!row.ciphertext) return null

  try {
    return {
      accountId: row.accountId,
      locationId: row.locationId,
      clientId: row.clientId,
      // Both sealed with the same tenant-id AAD, so a row copied between
      // tenants fails here rather than authorising as the wrong venue.
      clientSecret: decryptSecret(row.clientSecretCiphertext, tenantId),
      refreshToken: decryptSecret(row.ciphertext, tenantId),
    }
  } catch (e) {
    // The tenant and the failure mode — never the ciphertext, the token, or any
    // recovered bytes.
    console.error(
      `[google-credentials] failed to decrypt the stored secrets for tenant ${tenantId}:`,
      e instanceof Error ? e.name : 'unknown error',
    )
    if (e instanceof DecryptionError) throw e
    throw new DecryptionError('Could not decrypt the stored Google secrets for this venue.')
  }
}

/**
 * Store (or replace) a tenant's connection.
 *
 * `tenant_id` is the primary key and the conflict target, so this can only ever
 * touch one row, and `connected_at` is refreshed because reconnecting IS a new
 * connection. The sync bookkeeping is cleared: a fresh token has not failed yet,
 * and carrying an old error forward would misreport the new connection.
 */
export async function saveGoogleOAuthClient(
  tenantId: string,
  input: { accountId: string; locationId: string; clientId: string; clientSecret: string },
  db: DB = ownerDb,
): Promise<void> {
  const values = {
    googleAccountId: input.accountId.trim(),
    googleLocationId: input.locationId.trim(),
    oauthClientId: input.clientId.trim(),
    oauthClientSecretEncrypted: encryptSecret(input.clientSecret, tenantId),
    // Cleared: re-saving the client pair invalidates any token obtained
    // against the OLD one, so keeping it would leave a token that cannot be
    // exchanged and a status that claims otherwise. The owner re-authorises.
    refreshTokenEncrypted: null,
    connectedAt: new Date(),
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncAttempt: null,
  }
  await db
    .insert(googleBusinessCredentials)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: googleBusinessCredentials.tenantId, set: values })
}

/**
 * Store the refresh token Google returned, against a client pair already saved.
 *
 * Separate from saveGoogleOAuthClient() because the two halves arrive from
 * different places at different times: the client pair is typed into a
 * settings form, the token comes back on an OAuth redirect. Writing them
 * together would mean the callback had to re-supply a client secret it never
 * had — and would give it a reason to hold one.
 *
 * The UPDATE is scoped to a tenant that already HAS a row, so a callback
 * cannot conjure a connection for a tenant that never configured one.
 */
export async function saveGoogleRefreshToken(
  tenantId: string,
  refreshToken: string,
  db: DB = ownerDb,
): Promise<boolean> {
  const updated = await db
    .update(googleBusinessCredentials)
    .set({
      refreshTokenEncrypted: encryptSecret(refreshToken, tenantId),
      connectedAt: new Date(),
      // A fresh grant has not failed yet; carrying an old error forward
      // would misreport the new one.
      lastSyncError: null,
    })
    .where(eq(googleBusinessCredentials.tenantId, tenantId))
    .returning({ tenantId: googleBusinessCredentials.tenantId })
  return updated.length === 1
}

/**
 * Forget a tenant's connection.
 *
 * The CACHED REVIEWS are deliberately left alone. Disconnecting means "stop
 * syncing", not "erase what you already showed" — and a venue that reconnects
 * should not have a homepage that goes blank in between. Deleting them is a
 * separate, explicit act.
 */
export async function deleteGoogleConnection(tenantId: string, db: DB = ownerDb): Promise<void> {
  await db
    .delete(googleBusinessCredentials)
    .where(eq(googleBusinessCredentials.tenantId, tenantId))
}

/**
 * The connection WITHOUT the secret, for an owner-facing settings screen.
 *
 * A separate function rather than a flag on the one above, so a caller that
 * only wants to show "connected since March" cannot accidentally hold a
 * decrypted token in scope.
 */
export async function getGoogleConnectionStatus(
  tenantId: string,
  db: DB = ownerDb,
): Promise<GoogleConnectionStatus | null> {
  const [row] = await db
    .select({
      accountId: googleBusinessCredentials.googleAccountId,
      locationId: googleBusinessCredentials.googleLocationId,
      clientId: googleBusinessCredentials.oauthClientId,
      // Read only to answer "is there one". Discarded below, never returned.
      refreshToken: googleBusinessCredentials.refreshTokenEncrypted,
      connectedAt: googleBusinessCredentials.connectedAt,
      lastSyncedAt: googleBusinessCredentials.lastSyncedAt,
      lastSyncError: googleBusinessCredentials.lastSyncError,
    })
    .from(googleBusinessCredentials)
    .where(eq(googleBusinessCredentials.tenantId, tenantId))
    .limit(1)
  if (!row) return null
  const { refreshToken, ...rest } = row
  return { ...rest, authorised: refreshToken !== null }
}
