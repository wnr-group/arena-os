import { RESERVED_SLUGS } from '@/lib/tenant/subdomain'

/**
 * The ONE definition of what a workspace subdomain may be (M16 #6).
 *
 * Extracted from lib/actions/platform.ts, which is where this regex lived while
 * a platform admin was the only person who could choose a slug. Self-serve
 * signup made that a second, public entry point, and two copies of a rule that
 * decides what a hostname may contain is exactly the kind of drift that ends
 * with one path accepting something the other — and the database — rejects.
 *
 * ── The three layers, and which one is actually load-bearing ────────────────
 *
 *   1. this schema        shape, length, reserved names — a good error message
 *   2. the availability   "is it free right now?" — a good user experience
 *      check
 *   3. `tenants.slug`     NOT NULL UNIQUE plus the identical CHECK regex
 *      (0001_init.sql)     — the only thing that is actually true
 *
 * Layers 1 and 2 exist so a person is told what is wrong before they submit.
 * Neither is a guarantee: between a successful availability check and the
 * INSERT that follows, another signup can take the same slug. That race is not
 * closed by checking harder, it is closed by the unique index, and every caller
 * here is written to treat a 23505 as the real answer rather than an internal
 * error. See lib/signup/service.ts.
 *
 * The regex is character-for-character the CHECK constraint in 0001, on
 * purpose. If they ever diverge the database wins and the user sees a generic
 * failure instead of a field error, so they are kept identical by having one
 * copy here rather than one per caller.
 */

/** Matches the CHECK on `tenants.slug` in 0001_init.sql exactly. 3–50 chars. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/

export const SLUG_RULES =
  'Use 3–50 characters: lowercase letters, numbers and hyphens, starting and ending with a letter or number.'

/**
 * Fold user input toward the canonical form BEFORE validating it.
 *
 * Deliberately conservative: it trims, lowercases and collapses whitespace to
 * hyphens, and does nothing else. It does NOT strip characters the pattern
 * forbids — someone typing `my café` should be told the slug is invalid, not
 * silently given `my-caf`, which is a different business name than the one they
 * think they registered.
 */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-')
}

export type SlugProblem = 'empty' | 'shape' | 'reserved'

/**
 * Why this slug is unacceptable, or null when it is fine.
 *
 * Returns a REASON rather than a boolean so the caller can decide how much to
 * say. The signup form names the problem; a public availability endpoint may
 * choose to be vaguer. Availability is deliberately not checked here — that
 * needs the database, and keeping this module pure lets the client and the
 * server share it and lets a test exercise every boundary with no fixtures.
 */
export function slugProblem(slug: string): SlugProblem | null {
  if (!slug) return 'empty'
  if (!SLUG_PATTERN.test(slug)) return 'shape'
  if (RESERVED_SLUGS.has(slug)) return 'reserved'
  return null
}

/** A sentence for each problem, so every caller words them the same way. */
export function slugProblemMessage(problem: SlugProblem): string {
  switch (problem) {
    case 'empty':
      return 'Choose a workspace address.'
    case 'shape':
      return SLUG_RULES
    case 'reserved':
      return 'That address is reserved. Please choose another.'
  }
}

/**
 * A starting suggestion derived from the business name.
 *
 * Convenience only — it is offered to the user, never applied on their behalf,
 * and it goes through exactly the same validation as anything typed by hand.
 * Unlike normalizeSlug() this one DOES strip, because here the input is a
 * business name rather than a slug the user chose: turning "Joe's Gaming Café"
 * into `joes-gaming-caf` is a helpful first guess, whereas silently rewriting
 * something they typed into the slug field would not be.
 */
export function suggestSlug(businessName: string): string {
  return businessName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
}
