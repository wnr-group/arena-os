import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listActiveKots } from '@/lib/kots/data'
import { listMenuItems } from '@/lib/menu/data'
import { KitchenQueue, type KotTicket } from '@/components/kitchen/KitchenQueue'

export default async function KitchenPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [rows, menuItemRows] = await Promise.all([listActiveKots(ctx, branch.id), listMenuItems(ctx)])

  // Flat rows → one ticket per KOT, its order items nested — same grouping
  // shape as app/(app)/bookings/page.tsx uses for a booking's food orders.
  const ticketsById = new Map<string, KotTicket>()
  for (const row of rows) {
    let ticket = ticketsById.get(row.kotId)
    if (!ticket) {
      ticket = {
        kotId: row.kotId,
        kotNumber: row.kotNumber,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        orderNumber: row.orderNumber,
        channel: row.channel,
        stationName: row.stationName,
        items: [],
      }
      ticketsById.set(row.kotId, ticket)
    }
    if (row.itemId) {
      ticket.items.push({
        itemId: row.itemId,
        itemName: row.itemName!,
        qty: row.qty!,
        specialInstructions: row.specialInstructions,
      })
    }
  }

  // 86 applies to available/out_of_stock only — 'hidden' items are a
  // manager-only menu-settings decision (lib/actions/menu.ts::
  // setMenuItemAvailability refuses to touch them regardless).
  const eightySixItems = menuItemRows
    .filter((i) => i.status !== 'hidden')
    .map((i) => ({
      id: i.id,
      name: i.name,
      categoryName: i.categoryName,
      status: i.status as 'available' | 'out_of_stock',
    }))

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Kitchen</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Active tickets — this screen updates itself every few seconds.
      </p>
      <KitchenQueue tickets={[...ticketsById.values()]} menuItems={eightySixItems} />
    </div>
  )
}
