import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { canManageIncomingOrders, isManager } from '@/lib/auth/roles'
import { listIncomingOnlineOrders, listAwaitingPaymentOrders } from '@/lib/orders/data'
import { getOrderSettings } from '@/lib/orders/settings'
import { IncomingOrdersQueue, type IncomingOrder } from '@/components/orders/IncomingOrdersQueue'

export default async function IncomingOrdersPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — acceptOnlineOrder/rejectOnlineOrder re-check this
  // themselves (lib/actions/orders.ts).
  if (!canManageIncomingOrders(ctx.role)) redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [rows, awaitingPaymentRows, settings] = await Promise.all([
    listIncomingOnlineOrders(ctx, branch.id),
    listAwaitingPaymentOrders(ctx, branch.id),
    getOrderSettings(ctx),
  ])

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Incoming orders</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Online orders awaiting your accept or reject — this screen updates itself every few seconds.
      </p>
      <IncomingOrdersQueue
        orders={groupIntoOrders(rows)}
        awaitingPaymentOrders={groupIntoOrders(awaitingPaymentRows)}
        currency={ctx.tenant.currency}
        autoAcceptEnabled={settings.autoAcceptOnlineOrders}
        canManageSettings={isManager(ctx.role)}
      />
    </div>
  )
}

// Flat rows → one order per card, its items nested — same grouping shape as
// app/(app)/kitchen/page.tsx uses for KOTs.
function groupIntoOrders(
  rows: {
    orderId: string
    orderNumber: string
    createdAt: Date
    stationName: string | null
    itemId: string | null
    itemName: string | null
    qty: number | null
    specialInstructions: string | null
    lineTotal: string | null
  }[],
): IncomingOrder[] {
  const ordersById = new Map<string, IncomingOrder>()
  for (const row of rows) {
    let order = ordersById.get(row.orderId)
    if (!order) {
      order = {
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        createdAt: row.createdAt.toISOString(),
        stationName: row.stationName,
        items: [],
      }
      ordersById.set(row.orderId, order)
    }
    if (row.itemId) {
      order.items.push({
        itemId: row.itemId,
        itemName: row.itemName!,
        qty: row.qty!,
        specialInstructions: row.specialInstructions,
        lineTotal: row.lineTotal!,
      })
    }
  }
  return [...ordersById.values()]
}
