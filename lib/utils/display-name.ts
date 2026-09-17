/**
 * The character rule for user-chosen display names in Settings — tax rates,
 * menu items and categories, modifier groups, happy hours.
 *
 * It lived as five identical copies of the same regex, one per manager
 * component, until tax rates needed `%` ("GST 5%") and widening one copy would
 * have left the other four quietly stricter. One definition, imported
 * everywhere, so the rule and the message it produces can never disagree.
 *
 * WHAT IT IS FOR: tidiness, not safety. These names are labels — nothing
 * downstream parses them (GST arithmetic reads `tax_rates.percent` alone, see
 * lib/billing/pricing.ts), and React escapes them wherever they render. It
 * keeps `<script>`, quotes and semicolons out of a shop's menu because they
 * have no business in a dish name, not because anything breaks if they get in.
 *
 * WHERE IT IS ENFORCED: the browser only. The server actions behind these
 * screens accept any non-empty name, so this is a typing aid rather than a
 * guarantee — worth knowing before relying on it for anything that matters.
 *
 * Letters and numbers are Unicode classes on purpose: "Café", "ரசம்", "चाय"
 * and "Пиво" are all legitimate names on an Indian shop floor and none of them
 * are ASCII.
 *
 * `\p{M}` (combining marks) is there for the same reason and is NOT optional:
 * Indic scripts build syllables from a letter plus a mark, so "ரசம்" ends in
 * U+0BCD TAMIL SIGN VIRAMA — a Mark, not a Letter. Without it every Tamil,
 * Hindi, Telugu or Kannada name that carries a matra is rejected, which is
 * what the five copies of this rule used to do.
 */
export const DISPLAY_NAME_PATTERN = /^[\p{L}\p{M}\p{N} &'.,()%+\/:-]+$/u

/** The message shown when DISPLAY_NAME_PATTERN rejects a name. */
export const DISPLAY_NAME_ERROR =
  "Name can only contain letters, numbers, spaces, and & - ' . , ( ) % + / :"
