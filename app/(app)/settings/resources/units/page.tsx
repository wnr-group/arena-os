import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listResourceTypes, listResources } from '@/lib/booking/data'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { ResourcesManager } from '@/components/settings/ResourcesManager'

export default async function ResourcesUnitsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  // primary branch for this tenant (scheduling entities hang off a branch)
  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )

  const [types, res] = await Promise.all([
    listResourceTypes(ctx),
    branch ? listResources(ctx, branch.id) : Promise.resolve([]),
  ])

  if (!branch) {
    return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Resources</h1>
      <ResourcesManager
        branchId={branch.id}
        currency={ctx.tenant.currency}
        types={types.map((t) => ({
          id: t.id,
          name: t.name,
          hourlyRate: t.hourlyRate,
          imageUrl: t.imageUrl,
          isActive: t.isActive,
        }))}
        resources={res.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          resourceTypeId: r.resourceTypeId,
          typeName: r.typeName,
          rateOverride: r.rateOverride,
          imageUrl: r.imageUrl,
          description: r.description,
          typeImageUrl: r.typeImageUrl,
          typeDescription: r.typeDescription,
        }))}
      />
    </div>
  )
}
