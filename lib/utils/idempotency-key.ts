/**
 * A retry token for payment submissions.
 *
 * ── Why not `crypto.randomUUID()` ───────────────────────────────────────────
 * It is specified as SECURE-CONTEXT ONLY. Browsers expose it on https:// and on
 * localhost, and nowhere else — so on this project's dev host
 * (`{slug}.lvh.me:3000`, plain http and not "localhost") it is simply
 * `undefined`, and calling it throws:
 *
 *     TypeError: crypto.randomUUID is not a function
 *
 * That is a nasty failure mode, because it works in production over TLS and
 * breaks in development, or on any deployment served over plain http behind a
 * terminating proxy. `crypto.getRandomValues()` carries no such restriction, so
 * the token is built from that instead.
 *
 * ── What this token is, and is not ──────────────────────────────────────────
 * It is a DEDUPLICATION marker: the server uses it to recognise that two
 * submissions are the same attempt. It is not a secret and grants nothing — it
 * is only ever accepted alongside an authenticated session, and reusing one
 * against a different invoice is refused. The requirement is uniqueness, not
 * unguessability, and 128 bits from getRandomValues gives that comfortably.
 *
 * Client-safe: no `server-only`, no Node built-ins, usable from a component.
 */

/** Hex-encode bytes without pulling in Buffer (which is not in the browser). */
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * 128 bits of randomness as a 32-character hex string.
 *
 * Falls back in two steps so this can never be the thing that breaks a payment:
 *   1. `crypto.getRandomValues` — available in every context, secure or not,
 *      and in Node 18+ as a global.
 *   2. `Math.random` plus a timestamp — not cryptographic, but this token only
 *      needs to be unique, and a collision would at worst deduplicate two
 *      genuinely separate tenders taken in the same millisecond by the same
 *      cashier. The server's unique index would surface that rather than
 *      silently double-charge.
 */
export function newIdempotencyKey(): string {
  const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined

  if (webCrypto?.getRandomValues) {
    return toHex(webCrypto.getRandomValues(new Uint8Array(16)))
  }

  // Last resort. Timestamp first so two calls in different milliseconds cannot
  // collide even if the random half repeats.
  const stamp = Date.now().toString(16).padStart(12, '0')
  const noise = Array.from({ length: 5 }, () =>
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0'),
  ).join('')
  return `${stamp}${noise}`.slice(0, 32)
}
