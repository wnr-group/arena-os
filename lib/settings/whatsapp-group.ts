/**
 * The tenant's WhatsApp group invite link — the rules, stated once.
 *
 * Deliberately free of `server-only`, drizzle and db/schema imports, exactly
 * like ./business-profile's siblings lib/events/lifecycle.ts and
 * lib/events/registration.ts: the owner's settings form is a client component
 * and has to validate with the SAME rule the server saves with and the public
 * confirmation page redirects with. One rule, three callers.
 *
 * ══ WHY THE HOST IS AN ALLOWLIST AND NOT `z.string().url()` ═════════════════
 *
 * This value drives an AUTOMATIC `window.location.href` on a public page that
 * every booking customer lands on. A free-text URL field would therefore be an
 * open redirect with a settings screen attached — one mistyped or malicious
 * paste and every customer of that venue is sent wherever it points. Pinning
 * the host to chat.whatsapp.com makes the whole class of problem
 * unrepresentable rather than merely unlikely, and it costs nothing: there is
 * exactly one shape a WhatsApp group invite comes in.
 *
 * The same regex is a CHECK constraint in migration 0103, so a row that could
 * drive an off-host redirect cannot be written even by SQL.
 *
 * ══ NORMALISATION IS PART OF THE SAFETY, NOT TIDINESS ══════════════════════
 *
 * The canonical form is `https://chat.whatsapp.com/<code>` and nothing else —
 * the query string and fragment are DROPPED. That is what guarantees the
 * requirement "do not send the customer's phone number or other customer data
 * to WhatsApp" structurally: there is no parameter left for anything to be
 * appended to, whatever an owner pastes in.
 */
import { z } from 'zod'

/** The only host a stored invite may point at. */
export const WHATSAPP_GROUP_HOST = 'chat.whatsapp.com'

/**
 * How long the confirmation page counts down before redirecting.
 *
 * The brief asks for 5–8 seconds; six is long enough to read a booking number
 * and short enough that nobody wonders whether the page is stuck.
 */
export const WHATSAPP_REDIRECT_SECONDS = 6

export const WHATSAPP_GROUP_URL_MESSAGE =
  'Enter a WhatsApp group invite link — it looks like https://chat.whatsapp.com/AbC123DeF456.'

export const WHATSAPP_GROUP_ENABLED_MESSAGE =
  'Add a WhatsApp group link before turning the invite on.'

/** Length cap, mirrored by the column's CHECK. */
export const MAX_WHATSAPP_GROUP_URL_LENGTH = 2000

/**
 * The invite code itself. WhatsApp currently issues 22 alphanumeric characters;
 * the bounds are wider than that on purpose, because the code's length is
 * WhatsApp's business and has changed before. The character class is not wider
 * than that on purpose — it is what keeps a path traversal or an encoded host
 * out of the canonical string this module hands to `window.location.href`.
 */
const INVITE_CODE = /^[A-Za-z0-9_-]{6,64}$/

/**
 * The canonical invite URL, or null when the input is not one.
 *
 * Null covers every rejection identically — blank, not a URL at all, http,
 * another host, a path that is not an invite — because every one of them means
 * the same thing to every caller: there is no link to offer.
 *
 * Both legacy shapes are accepted (`/<code>` and `/invite/<code>`, which older
 * WhatsApp clients still produce) and both normalise to the modern one, so a
 * venue pasting a link from an old chat gets a working button rather than a
 * validation error it cannot explain.
 */
export function normalizeWhatsappGroupUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed.length > MAX_WHATSAPP_GROUP_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  // https only. An http invite would be downgraded in transit and is never
  // what WhatsApp issues.
  if (url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== WHATSAPP_GROUP_HOST) return null

  const parts = url.pathname.split('/').filter(Boolean)
  const code =
    parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === 'invite' ? parts[1] : null
  if (!code || !INVITE_CODE.test(code)) return null

  // Rebuilt from the pieces that passed, never echoed back from the input —
  // which is what drops the query and fragment.
  return `https://${WHATSAPP_GROUP_HOST}/${code}`
}

/** True when `raw` is a WhatsApp group invite this project will redirect to. */
export function isWhatsappGroupUrl(raw: string | null | undefined): boolean {
  return normalizeWhatsappGroupUrl(raw) !== null
}

/**
 * WHEN the countdown is allowed to arm. Pure, so it can be tested without a
 * browser — the component only supplies the four facts and renders the answer.
 *
 * Every clause is here because auto-redirecting is a hostile act in some state
 * the page can legitimately be in:
 *
 *   fromNewBooking   /b/[token] is NOT only a post-booking page. It is also the
 *                    CHECK-IN QR page ("Show this code at the door"), and it is
 *                    linked from My Bookings and the portal. Redirecting away
 *                    from it would take the QR off the screen of somebody
 *                    standing at the counter. Only the booking flow's own
 *                    success hand-off sets ?new=1, so only that arrives armed.
 *
 *   awaitingPayment  A booking is `confirmed` the moment it is created, before
 *                    any deposit is settled — including when the customer
 *                    DISMISSED the Razorpay modal without paying. That page
 *                    tells them they still owe money; bouncing them to WhatsApp
 *                    six seconds later means they never read it. The button
 *                    stays, so joining is still one tap.
 *
 *   alreadySpent     Back after a redirect must not redirect again.
 *
 *   backForward      The same guard, for when sessionStorage is unavailable
 *                    (private mode throws): the browser's own navigation type
 *                    still tells us this is a Back. Without it a private-mode
 *                    customer is trapped in a loop with no way to the booking.
 *
 * The manual button is NEVER gated by any of this — see the component.
 */
export function shouldAutoRedirectToWhatsapp(input: {
  fromNewBooking: boolean
  awaitingPayment: boolean
  alreadySpent: boolean
  backForward: boolean
}): boolean {
  return (
    input.fromNewBooking && !input.awaitingPayment && !input.alreadySpent && !input.backForward
  )
}

/**
 * The two fields as they arrive from the settings form.
 *
 * Blank is a legitimate value — it is how an owner removes the link — so the
 * shape only insists that a NON-blank value is a real invite. The paired rule
 * ("enabled needs a link") lives on the composed profile schema in
 * ./business-profile, because it is a rule ABOUT the pair.
 */
export const whatsappGroupFields = {
  whatsappGroupUrl: z
    .string()
    .trim()
    .max(MAX_WHATSAPP_GROUP_URL_LENGTH, 'That WhatsApp link is too long.')
    .refine((v) => v === '' || isWhatsappGroupUrl(v), WHATSAPP_GROUP_URL_MESSAGE)
    .optional()
    .nullable(),
  /**
   * REQUIRED, not optional-with-a-default. upsertBusinessProfile() replaces the
   * whole row, so an omitted boolean would silently switch the feature off —
   * and unlike the text fields, "off" is not obviously wrong when you look at
   * the saved profile. Making the caller state it turns a silent regression
   * into a compile error.
   */
  whatsappGroupEnabled: z.boolean(),
}
