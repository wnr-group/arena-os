/**
 * Phone normalisation. A customer is identified by `(tenant_id, phone)`, so the
 * SAME person typed five different ways must collapse to one stored value or the
 * unique index cannot do its job:
 *
 *   9876543210        98765 43210       +91 9876543210
 *   +91-9876543210    09876543210       →  all become +919876543210
 *
 * Output is E.164 ('+' followed by country code and national number, digits
 * only), which is unambiguous, sorts and compares byte-wise, and stays correct
 * if a tenant ever takes an international customer. Migration 0007 puts a CHECK
 * on `customers.phone` matching this shape, so an un-normalised write fails
 * loudly rather than quietly creating a duplicate.
 *
 * Pure and dependency-free, like lib/booking/time.ts — no library needed for the
 * handful of formats Indian front-desk staff actually type.
 */

/** Default calling code applied to a bare national number (India). */
export const DEFAULT_CALLING_CODE = '91'

/**
 * Length of a national significant number in the default country. Indian mobile
 * numbers are exactly 10 digits, which is what lets us tell `9198…` (country
 * code + national) apart from a bare national number.
 */
const NATIONAL_LENGTH = 10

/** E.164 allows at most 15 digits in total; below ~8 it isn't a real number. */
const MIN_DIGITS = 8
const MAX_DIGITS = 15

export function normalizePhone(
  raw: string | null | undefined,
  callingCode: string = DEFAULT_CALLING_CODE,
): string | null {
  if (!raw) return null

  const trimmed = raw.trim()
  if (!trimmed) return null

  // An explicit international prefix — '+' or the '00' trunk form — means the
  // country code is already present and we must not add one.
  const isInternational = trimmed.startsWith('+') || /^00\d/.test(trimmed)

  let digits = trimmed.replace(/\D/g, '')
  if (isInternational && digits.startsWith('00')) digits = digits.slice(2)

  if (!digits) return null

  if (!isInternational) {
    // National form. Strip a trunk prefix ('0' before the subscriber number),
    // then strip the country code if the caller typed it without a '+'
    // (e.g. 919876543210).
    digits = digits.replace(/^0+/, '')
    if (digits.startsWith(callingCode) && digits.length === callingCode.length + NATIONAL_LENGTH) {
      digits = digits.slice(callingCode.length)
    }
    digits = callingCode + digits
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null
  // A country code never starts with 0.
  if (digits.startsWith('0')) return null

  return `+${digits}`
}
