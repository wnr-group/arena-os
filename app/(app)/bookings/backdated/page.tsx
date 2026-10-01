import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listResources, listResourceSetups } from '@/lib/booking/data'
import { todayInZone } from '@/lib/booking/time'
import { industryHasStudioSetups } from '@/lib/booking/studio-setups'
import { BackdatedBookingForm } from '@/components/bookings/BackdatedBookingForm'

/**
 * "Record a past booking" (M28 #3) — owner/manager back-fill of a session that
 * already happened. Redirecting a non-manager is convenience only; the action
 * (recordBackdatedBooking) re-checks requireManager() itself.
 */
export default async function BackdatedBookingPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/bookings')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const setupsEnabled = industryHasStudioSetups(ctx.tenant.industry)
  const [allResources, allSetups] = await Promise.all([
    listResources(ctx, branch.id),
    setupsEnabled ? listResourceSetups(ctx, branch.id) : Promise.resolve([]),
  ])

  const setupsByResource: Record<string, { id: string; name: string }[]> = {}
  for (const s of allSetups) {
    if (!s.isActive) continue
    ;(setupsByResource[s.resourceId] ??= []).push({ id: s.id, name: s.name })
  }

  const resources = allResources
    .filter((r) => r.status !== 'inactive')
    .map((r) => ({
      id: r.id,
      name: r.name,
      typeName: r.typeName,
      pricingMode: r.pricingMode,
      minPlayers: r.minPlayers,
      // M29 #4: a per_resource board with an extra-player rate also takes a player count.
      includedPlayers: r.includedPlayers,
      hasSurcharge: r.pricingMode === 'per_resource' && r.extraPlayerRate !== null,
      setups: setupsByResource[r.id] ?? [],
    }))

  return (
    <BackdatedBookingForm
      branchId={branch.id}
      timeZone={ctx.tenant.timezone}
      currency={ctx.tenant.currency}
      today={todayInZone(ctx.tenant.timezone)}
      resources={resources}
    />
  )
}
