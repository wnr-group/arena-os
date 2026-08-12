/**
 * Customer note text rules.
 */

/** A note longer than this belongs somewhere else. */
export const MAX_NOTE_LENGTH = 2000

export function normalizeNoteBody(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}
