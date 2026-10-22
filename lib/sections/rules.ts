/**
 * Pure floor-section rules (M20 / AROS-178) — no DB, no `server-only`.
 */

/** Roles that can wait tables. Kitchen staff cook; they are never a table's server. */
export const SERVER_ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff'] as const

export function canBeServer(role: string | null | undefined): boolean {
  return !!role && (SERVER_ROLES as readonly string[]).includes(role)
}

/** A table-level assignment overrides the section's. */
export function effectiveServerId(tableServerId: string | null, sectionServerId: string | null): string | null {
  return tableServerId ?? sectionServerId ?? null
}

export function validateSectionName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a section name.'
  if (n.length > 60) return 'Section names can be at most 60 characters.'
  return null
}

export type SectionGroup<T> = { sectionId: string | null; name: string | null; tables: T[] }

/**
 * Group floor tables under their section headings, in section order, with
 * unsectioned tables last. Table order inside a group is preserved. If no table
 * belongs to a section the result is one headingless group — the floor then
 * renders exactly as it did before sections existed.
 */
export function groupTablesBySection<T extends { sectionId: string | null; sectionName: string | null; sectionSort: number | null }>(
  tables: T[],
): SectionGroup<T>[] {
  if (!tables.some((t) => t.sectionId)) return [{ sectionId: null, name: null, tables }]
  const groups = new Map<string, SectionGroup<T> & { sort: number }>()
  const loose: T[] = []
  for (const t of tables) {
    if (!t.sectionId) {
      loose.push(t)
      continue
    }
    let g = groups.get(t.sectionId)
    if (!g) {
      g = { sectionId: t.sectionId, name: t.sectionName, tables: [], sort: t.sectionSort ?? 0 }
      groups.set(t.sectionId, g)
    }
    g.tables.push(t)
  }
  const ordered: SectionGroup<T>[] = [...groups.values()]
    .sort((a, b) => a.sort - b.sort || (a.name ?? '').localeCompare(b.name ?? ''))
    .map(({ sectionId, name, tables: ts }) => ({ sectionId, name, tables: ts }))
  if (loose.length > 0) ordered.push({ sectionId: null, name: 'Other tables', tables: loose })
  return ordered
}
