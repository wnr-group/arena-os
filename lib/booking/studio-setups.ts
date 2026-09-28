/**
 * M24 — Studio Setups (named priced configurations of one physical resource,
 * e.g. "Kitchen"/"Royal" on a recording studio's Set A) is scoped to these
 * four industries only. Every other industry — including gaming_cafe's
 * existing independent-unit model (PS5-1, PS5-2, Snooker-1, …) and
 * restaurant's per-table model — keeps its current resource behaviour
 * completely unchanged. A single allowlist here is the one place every
 * gating check (the settings editor, the staff booking wizard, and the
 * upsertResourceSetup action itself) reads from, so the four industries
 * can't drift apart across call sites.
 */
export const STUDIO_SETUP_INDUSTRIES = ['recording_studio', 'podcast_studio', 'dance_studio', 'vr_centre'] as const

export function industryHasStudioSetups(industry: string): boolean {
  return (STUDIO_SETUP_INDUSTRIES as readonly string[]).includes(industry)
}
