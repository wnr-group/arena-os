/**
 * Customer tag normalisation.
 */

/** Longer than this is a note, not a tag. */
export const MAX_TAG_LENGTH = 32

/** Keeps the chip row on the profile readable, and the array bounded. */
export const MAX_TAGS = 20

export function normalizeTag(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH).trim()
  return cleaned || null
}

/** Case-insensitive membership test — the rule that defines "duplicate" here. */
export function hasTag(tags: readonly string[], tag: string): boolean {
  const needle = normalizeTag(tag)?.toLowerCase()
  if (!needle) return false
  return tags.some((t) => t.trim().toLowerCase() === needle)
}

export function normalizeTags(raw: readonly (string | null | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const candidate of raw) {
    const tag = normalizeTag(candidate)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length === MAX_TAGS) break
  }

  return out
}
