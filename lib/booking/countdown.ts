/**
 * Remaining/overdue time until `endIso` (M21 #5) — pure, client-safe, no
 * server dependency. Derived fresh from `endIso` and the current instant
 * every call, so a countdown built on this survives a page reload with no
 * client-side state of its own: reload the page, re-read committed_end_at,
 * get the same number back.
 */
export function formatCountdown(endIso: string, nowMs: number = Date.now()): { text: string; overdue: boolean } {
  const diffMs = new Date(endIso).getTime() - nowMs
  const overdue = diffMs <= 0
  const totalMin = Math.round(Math.abs(diffMs) / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const clock = h > 0 ? `${h}h ${m}m` : `${m}m`
  return { text: overdue ? `Overdue by ${clock}` : `${clock} left`, overdue }
}
