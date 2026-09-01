import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listModifierGroups } from '@/lib/menu/data'
import { ModifierGroupsManager, type ModifierGroupRow } from '@/components/settings/ModifierGroupsManager'

export default async function ModifierGroupsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Restaurant-only surface (M17 #8): gated here, not just by hiding the nav
  // entry, so a non-restaurant tenant can never reach it by URL either — same
  // discipline app/(app)/floor/page.tsx uses.
  if (ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  if (!isManager(ctx.role)) redirect('/dashboard')

  const rows = await listModifierGroups(ctx)

  const groups: ModifierGroupRow[] = []
  const byId = new Map<string, ModifierGroupRow>()
  for (const row of rows) {
    let group = byId.get(row.groupId)
    if (!group) {
      group = {
        id: row.groupId,
        name: row.groupName,
        minSelect: row.minSelect,
        maxSelect: row.maxSelect,
        required: row.required,
        sortOrder: row.groupSortOrder,
        options: [],
      }
      byId.set(row.groupId, group)
      groups.push(group)
    }
    if (row.optionId) {
      group.options.push({
        id: row.optionId,
        name: row.optionName!,
        priceDelta: row.priceDelta!,
        sortOrder: row.optionSortOrder!,
      })
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Modifiers</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Sizes, add-ons and other choices — build a group once, then attach it to any menu items that offer it.
      </p>
      <ModifierGroupsManager currency={ctx.tenant.currency} groups={groups} />
    </div>
  )
}
