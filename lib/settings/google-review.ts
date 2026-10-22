/**
 * The tenant's Google review link — the rule, stated once.
 *
 * Pure, like ./whatsapp-group beside it and for the same reason: the owner's
 * settings form, the save action and the customer prompt must all agree about
 * what a valid link is, and the form is a client component that cannot import
 * a database driver.
 *
 * ══ WHY AN ALLOWLIST ════════════════════════════════════════════════════════
 *
 * This value becomes an outbound link shown to every eligible customer of a
 * venue. A free-text URL field would let one careless paste send all of them
 * somewhere arbitrary. Pinning the host makes that class of mistake
 * unrepresentable rather than merely unlikely.
 *
 * Unlike the WhatsApp invite, the QUERY STRING IS LOAD-BEARING here —
 * `search.google.com/local/writereview?placeid=…` is meaningless without it —
 * so normalisation keeps the query and drops only the fragment.
 *
 * ══ THE SHAPES GOOGLE ACTUALLY HANDS PEOPLE ═════════════════════════════════
 *
 *   https://g.page/r/<id>/review                  the "review us" short link
 *   https://search.google.com/local/writereview?placeid=<id>
 *                                                  the canonical write form
 *   https://maps.app.goo.gl/<code>                 the modern Maps share link
 *   https://goo.gl/maps/<code>                     the legacy one
 *   https://www.google.com/maps/place/…            copied from the address bar
 *   https://maps.google.com/…                      the same, older host
 *   https://www.google.co.in/maps/…                the same, on a country TLD
 *
 * All of them are accepted, because all of them are what a venue owner will
 * actually find when told "send us your Google review link". Anything else is
 * refused.
 */
import { z } from 'zod'

export const GOOGLE_REVIEW_URL_MESSAGE =
  'Enter a Google review or Maps link — for example https://g.page/r/AbC123/review or https://search.google.com/local/writereview?placeid=…'

export const GOOGLE_REVIEW_ENABLED_MESSAGE =
  'Add a Google review link before turning the prompt on.'

export const MAX_GOOGLE_REVIEW_URL_LENGTH = 2000

/**
 * `google.com`, `google.co.in`, `google.de` … and nothing that merely CONTAINS
 * them. Anchored at both ends, so `google.com.evil.example` is not a match —
 * which is the whole point of validating a host rather than a substring.
 */
const GOOGLE_HOST =
  /^(?:www\.|maps\.|search\.)?google\.(?:com|com\.[a-z]{2}|co\.[a-z]{2}|[a-z]{2,3})$/

/**
 * The canonical link, or null when the input is not one.
 *
 * Null covers every rejection identically — blank, not a URL, http, an
 * untrusted host, a Google page that is not a Maps or review link — because
 * they all mean the same thing to every caller: there is no link to offer, so
 * show nothing.
 */
export function normalizeGoogleReviewUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed.length > MAX_GOOGLE_REVIEW_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  // https only. Google never issues an http review link, and a downgraded one
  // is not something to send a customer to.
  if (url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()
  const path = url.pathname

  const ok =
    // The short "leave us a review" link. Any path — Google mints these opaquely.
    (host === 'g.page' && path.length > 1) ||
    // Maps share links, both generations.
    (host === 'maps.app.goo.gl' && path.length > 1) ||
    (host === 'goo.gl' && path.startsWith('/maps/')) ||
    // The write-a-review form. The placeid IS the link, so require it rather
    // than accepting a bare /local/writereview that would land nowhere.
    (host === 'search.google.com' &&
      path === '/local/writereview' &&
      !!url.searchParams.get('placeid')) ||
    // A Maps URL on any Google TLD. Restricted to /maps so this field cannot
    // quietly become "any page on google.com".
    (GOOGLE_HOST.test(host) && (path === '/maps' || path.startsWith('/maps/')))

  if (!ok) return null

  // Rebuilt from the parsed pieces, never echoed back from the input: the host
  // is lowercased and the fragment dropped. The query survives because
  // writereview needs it.
  return `https://${host}${path}${url.search}`
}

/** True when `raw` is a Google review link this project will send a customer to. */
export function isGoogleReviewUrl(raw: string | null | undefined): boolean {
  return normalizeGoogleReviewUrl(raw) !== null
}

/**
 * The two fields as the settings form sends them.
 *
 * Blank is legitimate — it is how an owner removes the link — so only a
 * NON-blank value must be a real one. The paired "enabled needs a link" rule
 * lives on the composed profile schema, because it is a rule about the pair.
 *
 * `googleReviewEnabled` is REQUIRED for the same reason the WhatsApp flag is:
 * upsertBusinessProfile() replaces the whole row, so an omitted boolean would
 * silently switch the feature off.
 */
export const googleReviewFields = {
  googleReviewUrl: z
    .string()
    .trim()
    .max(MAX_GOOGLE_REVIEW_URL_LENGTH, 'That Google link is too long.')
    .refine((v) => v === '' || isGoogleReviewUrl(v), GOOGLE_REVIEW_URL_MESSAGE)
    .optional()
    .nullable(),
  googleReviewEnabled: z.boolean(),
}
