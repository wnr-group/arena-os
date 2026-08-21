import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Application-level authenticated encryption for secrets held at rest.
 *
 * Built for per-tenant payment gateway credentials (migration 0022), but
 * deliberately generic — anything that must live in the database as ciphertext
 * should come through here rather than roll its own.
 *
 * ── Design ───────────────────────────────────────────────────────────────────
 *   * AES-256-GCM. Authenticated (AEAD): tampering with the ciphertext, the IV
 *     or the tag makes decryption FAIL rather than return garbage. Plain
 *     AES-CBC would not — an attacker with write access to the column could
 *     flip bits undetected.
 *   * A fresh 96-bit IV from the CSPRNG on EVERY encryption. Never a static or
 *     derived IV: GCM catastrophically loses confidentiality and integrity if a
 *     (key, IV) pair is ever reused.
 *   * The master key comes from the PAYMENT_SETTINGS_ENCRYPTION_KEY environment
 *     variable. It is never hardcoded, never generated at runtime, and never
 *     stored in the database.
 *   * Optional AAD binds a ciphertext to its context (the payment settings layer
 *     passes the tenant id). A row copied from one tenant to another therefore
 *     fails to decrypt instead of silently working.
 *
 * ── Wire format ──────────────────────────────────────────────────────────────
 *   v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 *
 * The leading version tag is what makes future key rotation possible: a `v2`
 * reader can recognise and re-wrap `v1` values. Base64 contains no ':', so the
 * split is unambiguous. Migration 0022 CHECKs that the stored column matches
 * `^v[0-9]+:` — a plaintext secret physically cannot be written into it.
 *
 * ── Rules for callers ────────────────────────────────────────────────────────
 *   * Server-only. `import 'server-only'` makes importing this from a client
 *     component a BUILD error, not a runtime surprise.
 *   * Never log a plaintext, a ciphertext, or the key. The errors thrown here
 *     carry no secret material for exactly that reason.
 */

/** Thrown when the master key is missing or malformed — a deployment fault. */
export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionConfigError'
  }
}

/** Thrown when a value cannot be decrypted: wrong key, tampering, corruption. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

const ENV_VAR = 'PAYMENT_SETTINGS_ENCRYPTION_KEY'
const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'
const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // 96-bit nonce, the GCM standard
const TAG_BYTES = 16

/**
 * Decode and validate the master key.
 *
 * Accepts 64 hex characters (`openssl rand -hex 32`, matching how SESSION_SECRET
 * is generated in .env.example) or 32 bytes of base64. Anything else is a
 * configuration fault and throws.
 *
 * Exported so a deployment check — or a test — can validate a candidate value
 * without reaching into process.env. It never echoes the value it was given.
 */
export function resolveMasterKey(raw: string | undefined = process.env[ENV_VAR]): Buffer {
  const value = raw?.trim()
  if (!value) {
    throw new EncryptionConfigError(
      `${ENV_VAR} is not set. Generate one with \`openssl rand -hex 32\` and add it to the server environment.`,
    )
  }

  let key: Buffer | null = null
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex')
  } else {
    // Base64 (or base64url). Buffer.from is lenient, so re-check the length.
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === KEY_BYTES) key = decoded
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new EncryptionConfigError(
      `${ENV_VAR} must be a 32-byte key — 64 hex characters or base64. Generate one with \`openssl rand -hex 32\`.`,
    )
  }

  // An all-zero key is what a misconfigured template or a Buffer.alloc default
  // produces. It is technically valid AES, which is precisely why it is worth
  // rejecting loudly.
  if (timingSafeEqual(key, Buffer.alloc(KEY_BYTES))) {
    throw new EncryptionConfigError(`${ENV_VAR} is all zero bytes — that is not a usable key.`)
  }

  return key
}

/**
 * The decoded master key, resolved once per process.
 *
 * Cached deliberately: re-parsing on every request would be wasted work, and
 * — more importantly — "generate a key if none is configured" must never be a
 * code path that exists. There is no fallback. A missing key throws, every time.
 */
let cachedKey: Buffer | null = null

function masterKey(): Buffer {
  if (!cachedKey) cachedKey = resolveMasterKey()
  return cachedKey
}

/**
 * Fail fast at boot (or in a health check) rather than at the moment a manager
 * tries to save credentials. Throws EncryptionConfigError when unusable.
 */
export function assertEncryptionConfigured(): void {
  masterKey()
}

/** True when a usable master key is present — for diagnostics that must not throw. */
export function isEncryptionConfigured(): boolean {
  try {
    masterKey()
    return true
  } catch {
    return false
  }
}

/**
 * Encrypt a secret for storage.
 *
 * @param plaintext the secret. Must be non-empty — storing an empty secret is
 *        always a bug, and callers should write NULL instead.
 * @param aad additional authenticated data bound to the ciphertext but not
 *        encrypted (the payment layer passes the tenant id). Decryption must
 *        supply the same value or it fails.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('encryptSecret requires a non-empty string.')
  }

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv, { authTagLength: TAG_BYTES })
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'))

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * Decrypt a stored secret. Server-side only, and the result must never be
 * returned to a browser.
 *
 * Throws DecryptionError on a bad version, a malformed value, a wrong AAD, a
 * wrong key, or any tampering. The message is deliberately generic — it never
 * includes the ciphertext, the key, or any recovered bytes.
 */
export function decryptSecret(encoded: string, aad?: string): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new DecryptionError('Stored secret is empty or not a string.')
  }

  const parts = encoded.split(':')
  if (parts.length !== 4) {
    throw new DecryptionError('Stored secret is not in the expected encrypted format.')
  }

  const [version, ivB64, tagB64, dataB64] = parts
  if (version !== VERSION) {
    // A future rotation adds a branch here rather than a breaking change.
    throw new DecryptionError(`Unsupported secret encryption version: ${sanitiseVersion(version)}.`)
  }

  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('Stored secret has a malformed nonce or authentication tag.')
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey(), iv, { authTagLength: TAG_BYTES })
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (e) {
    // A configuration fault is worth distinguishing from a tampering/wrong-key
    // failure; neither error carries any secret material.
    if (e instanceof EncryptionConfigError) throw e
    throw new DecryptionError(
      'Could not decrypt the stored secret — it was encrypted with a different key, or it has been altered.',
    )
  }
}

/** True when the value looks like output of encryptSecret(). No decryption. */
export function isEncryptedValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^v[0-9]+:[^:]+:[^:]+:[^:]+$/.test(value)
}

/** Keep an attacker-supplied version tag out of logs/messages verbatim. */
function sanitiseVersion(v: string): string {
  return /^v[0-9]{1,4}$/.test(v) ? v : 'unrecognised'
}
