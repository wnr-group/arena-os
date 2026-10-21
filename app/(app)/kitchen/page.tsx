import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listActiveKots } from '@/lib/kots/data'
import { listMenuItems } from '@/lib/menu/data'
import { KitchenQueue, type KotTicket } from '@/components/kitchen/KitchenQueue'
import Link from 'next/link'
import { PrintAlertBanner } from '@/components/kitchen/PrintAlertBanner'
import { getPrintAlert } from '@/lib/printing/queue'
import { KdsBoard } from '@/components/kitchen/KdsBoard'
import { KdsSettings } from '@/components/kitchen/KdsSettings'
import { getKdsBoard } from '@/lib/kots/kds-data'
import { getKdsSettingsCore } from '@/lib/kots/kds'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { canFireCourse, canManageKitchen, isManager } from '@/lib/auth/roles'

export default async function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<{ station?: string }>
}) {
  const sp = await searchParams
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

  // Network printing (M19 #4): a banner whenever paper is not coming out, and a
  // way into printer setup. Null/absent for tenants without the module or printers.
  const printing = ctx.tenant.industry === 'restaurant' && (await hasEntitlement(ctx, 'module.printing'))
  const printAlert = printing ? await getPrintAlert(ctx) : null
  const printHeader = printing && (
    <>
      <div className="mt-1 flex items-center gap-4 text-sm">
        <Link href="/kitchen/printers" className="font-medium text-primary hover:underline">
          Printers &amp; print queue
        </Link>
      </div>
      <PrintAlertBanner alert={printAlert} />
    </>
  )

  // The KDS needs all three: a restaurant tenant, a plan that includes it, and
  // the tenant's own opt-in. Anything less renders the unchanged ticket list.
  const kdsEligible = ctx.tenant.industry === 'restaurant' && (await hasEntitlement(ctx, 'module.kitchen_display'))
  const kdsSettings = kdsEligible
    ? await withUser(ctx.user.id, (tx) => getKdsSettingsCore(tx, ctx.tenant.id))
    : null

  if (kdsEligible && kdsSettings?.enabled) {
    // ?station=<uuid> = that station's screen, ?station=none = unrouted lines.
    const scope =
      sp.station === 'none'
        ? { id: null }
        : sp.station && /^[0-9a-f-]{36}$/i.test(sp.station)
          ? { id: sp.station }
          : undefined
    const [board, menuItemRows] = await Promise.all([getKdsBoard(ctx, branch.id, scope), listMenuItems(ctx)])
    return (
      <div className="mx-auto max-w-[110rem] px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold">Kitchen</h1>
        {printHeader}
        <KdsBoard
          board={board}
          canBump={canManageKitchen(ctx.role)}
          canFire={canFireCourse(ctx.role)}
          scope={board.settings.stationsEnabled ? scope : undefined}
          menuItems={menuItemRows
            .filter((i) => i.status !== 'hidden')
            .map((i) => ({ id: i.id, name: i.name, categoryName: i.categoryName, status: i.status as 'available' | 'out_of_stock' }))}
        />
        {isManager(ctx.role) && <KdsSettings {...kdsSettings} />}
      </div>
    )
  }

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
        modifiers: row.modifiers,
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
      {printHeader}
      <p className="mt-1 text-sm text-muted-foreground">
        Active tickets — this screen updates itself every few seconds.
      </p>
      <KitchenQueue tickets={[...ticketsById.values()]} menuItems={eightySixItems} />
      {kdsSettings && isManager(ctx.role) && <KdsSettings {...kdsSettings} />}
    </div>
  )
}
