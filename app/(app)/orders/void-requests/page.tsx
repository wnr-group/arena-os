import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { isManager } from '@/lib/auth/roles'
import { listPendingVoidRequests } from '@/lib/orders/data'
import { VoidRequestsQueue, type VoidRequest } from '@/components/orders/VoidRequestsQueue'

export default async function VoidRequestsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Restaurant-only surface (M17 #6): gated here, not just by hiding the nav
  // entry, so a non-restaurant tenant can never reach it by URL either — same
  // discipline app/(app)/floor/page.tsx uses.
  if (ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  // Presentation only — decideVoidRequest re-checks requireManager() itself
  // (lib/actions/orders.ts).
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const rows = await listPendingVoidRequests(ctx, branch.id)

  const requests: VoidRequest[] = rows.map((r) => ({
    requestId: r.requestId,
    mode: r.mode,
    reason: r.reason,
    requestedAt: r.requestedAt.toISOString(),
    requestedByName: r.requestedByName,
    itemName: r.itemName!,
    qty: r.qty!,
    amount: r.lineTotal!,
    orderNumber: r.orderNumber,
    bookingNumber: r.bookingNumber,
    tableName: r.tableName,
  }))

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Void/comp requests</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Waiter-raised void/comp requests awaiting your approval — this screen updates itself every few seconds.
      </p>
      <VoidRequestsQueue requests={requests} currency={ctx.tenant.currency} />
    </div>
  )
}
