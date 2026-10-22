import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { getSectionConfig, listServers } from '@/lib/sections/data'
import { SectionsManager } from '@/components/settings/SectionsManager'

export default async function SectionsSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.floor_sections'))) redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [servers, config] = await Promise.all([listServers(ctx), getSectionConfig(ctx, branch.id)])

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Floor sections &amp; servers</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Organise the floor into areas and say who is serving where. Each table session records its server, so sales and tips can be traced to them.
      </p>
      <SectionsManager branchId={branch.id} servers={servers} config={config} />
    </div>
  )
}
