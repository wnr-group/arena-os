/**
 * "Record a past booking" (M28) is a gaming-cafe-only feature. Every other
 * industry keeps its current bookings behaviour completely unchanged. This is
 * the single allowlist the entry point (bookings page button), the page route
 * and both server actions read from, so they can't drift apart.
 */
export const BACKDATED_ENTRY_INDUSTRIES = ['gaming_cafe'] as const

export function industryHasBackdatedEntry(industry: string): boolean {
  return (BACKDATED_ENTRY_INDUSTRIES as readonly string[]).includes(industry)
}
