/**
 * The four-tint system stat cards across the app use to colour-code a card by
 * MEANING, not position: rose = totals/headline count, mint = available/
 * active/confirmed/healthy, amber = needs attention, slate = hidden/inactive/
 * archived/cancelled. Values come from the --rose/--mint/--amber/--slate
 * design tokens in globals.css — never hardcode the hex here.
 *
 * Each StatCard is a local component (one per page/manager, no shared
 * component across the app), so this map is the one thing actually shared
 * between them — the single source of truth a card's `tint` prop resolves
 * through, rather than 15 copies of the same lookup drifting apart.
 */
export type StatTint = 'rose' | 'mint' | 'amber' | 'slate'

export const STAT_TINT_CLASSES: Record<StatTint, { card: string; icon: string }> = {
  rose: { card: 'bg-rose-bg border-rose-border', icon: 'text-rose' },
  mint: { card: 'bg-mint-bg border-mint-border', icon: 'text-mint' },
  amber: { card: 'bg-amber-bg border-amber-border', icon: 'text-amber' },
  slate: { card: 'bg-slate-bg border-slate-border', icon: 'text-slate' },
}
