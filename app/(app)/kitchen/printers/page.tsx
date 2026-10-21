import { redirect } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { kitchenStations, printers } from '@/db/schema'
import { isManager } from '@/lib/auth/roles'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { listPrintJobs } from '@/lib/printing/queue'
import { PrintersManager } from '@/components/kitchen/PrintersManager'

export default async function PrintersPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (ctx.tenant.industry !== 'restaurant' || !(await hasEntitlement(ctx, 'module.printing'))) redirect('/kitchen')

  const [{ printerRows, stationRows }, jobs] = await Promise.all([
    withUser(ctx.user.id, async (tx) => ({
      printerRows: await tx
        .select({
          id: printers.id,
          name: printers.name,
          kind: printers.kind,
          isDefault: printers.isDefault,
          isActive: printers.isActive,
          paperChars: printers.paperChars,
          mediaType: printers.mediaType,
          lastSeenAt: printers.lastSeenAt,
          lastStatus: printers.lastStatus,
        })
        .from(printers)
        .where(eq(printers.tenantId, ctx.tenant.id))
        .orderBy(asc(printers.kind), asc(printers.name)),
      stationRows: await tx
        .select({ id: kitchenStations.id, name: kitchenStations.name, printerId: kitchenStations.printerId })
        .from(kitchenStations)
        .where(eq(kitchenStations.tenantId, ctx.tenant.id))
        .orderBy(asc(kitchenStations.sortOrder), asc(kitchenStations.name)),
    })),
    listPrintJobs(ctx),
  ])

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Printers</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Network thermal printers (Star CloudPRNT) pull kitchen tickets and bills from here. No printer set up? Browser printing keeps
        working.
      </p>
      <PrintersManager
        printers={printerRows.map((p) => ({ ...p, lastSeenAt: p.lastSeenAt?.toISOString() ?? null }))}
        stations={stationRows}
        jobs={jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString() }))}
        canSetup={isManager(ctx.role)}
        serverNow={new Date().toISOString()}
      />
    </div>
  )
}
