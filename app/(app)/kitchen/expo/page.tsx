import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { getKdsBoard } from '@/lib/kots/kds-data'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { canManageKitchen } from '@/lib/auth/roles'
import { ExpoBoard } from '@/components/kitchen/ExpoBoard'

export default async function ExpoPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (ctx.tenant.industry !== 'restaurant' || !(await hasEntitlement(ctx, 'module.kitchen_display'))) redirect('/kitchen')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const board = await getKdsBoard(ctx, branch.id)
  if (!board.settings.enabled || !board.settings.stationsEnabled) redirect('/kitchen')

  return (
    <div className="mx-auto max-w-[110rem] px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Expo / pass</h1>
      <ExpoBoard board={board} canServe={canManageKitchen(ctx.role)} />
    </div>
  )
}
