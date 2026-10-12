/**
 * Pure helpers for the setup photo manager (components/settings/SetupPhotoStrip.tsx)
 * — no React, no server-only, so the rules are unit-testable on their own.
 */

/** Mirrors the server's cap (MAX_SETUP_IMAGES) and IMAGE_POLICY (lib/storage/s3.ts). */
export const SETUP_PHOTO_MAX = 3
export const SETUP_PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const SETUP_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/**
 * Client-side pre-check so an obviously bad file never costs a request (and a
 * file over the Server Action body limit never produces an opaque framework
 * error). The server re-validates everything — this is only for fast feedback.
 */
export function checkPhotoFile(file: { type: string; size: number }): string | null {
  if (!(SETUP_PHOTO_TYPES as readonly string[]).includes(file.type)) return 'Only JPEG, PNG, WEBP or GIF images are allowed.'
  if (file.size === 0) return 'The selected file is empty.'
  if (file.size > SETUP_PHOTO_MAX_BYTES) return 'Image must be smaller than 5MB.'
  return null
}

/**
 * A multi-select queued against the remaining slots: the first `room` files
 * are uploaded in order, the rest are ignored (the UI shows a notice).
 */
export function planUploads<T>(existingCount: number, files: T[]): { accepted: T[]; skipped: number } {
  const room = Math.max(0, SETUP_PHOTO_MAX - existingCount)
  return { accepted: files.slice(0, room), skipped: Math.max(0, files.length - room) }
}

/** Move the item at `index` one step; null when it can't move (edge / bad index). */
export function movePhoto<T>(list: T[], index: number, direction: -1 | 1): T[] | null {
  const to = index + direction
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return null
  const next = [...list]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}
