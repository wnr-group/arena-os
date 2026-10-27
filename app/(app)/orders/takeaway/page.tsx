import Link from 'next/link'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageWalkins, isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { listHappyHours } from '@/lib/happy-hours/data'
import { listMenuItems, listMenuItemModifierGroups, groupModifierGroupsByMenuItem } from '@/lib/menu/data'
import { getTypedOrderSettingsCore, listActiveTypedOrdersCore } from '@/lib/orders/typed'
import { TypedOrdersBoard } from '@/components/orders/TypedOrdersBoard'

/**
 * Takeaway & delivery (M20 / AROS-182): live orders with no table, their
 * kitchen stage and handover. Restaurant-only, plan-gated, front-of-house roles;
 * every action re-checks all three.
 */
export default async function TakeawayDeliveryPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (ctx.tenant.industry !== 'restaurant' || !canManageWalkins(ctx.role)) redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.takeaway_delivery'))) redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const settings = await withUser(ctx.user.id, (tx) => getTypedOrderSettingsCore(tx, ctx.tenant.id))
  if (!settings.takeawayEnabled && !settings.deliveryEnabled) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Takeaway &amp; delivery</h1>
        <p className="mt-2 text-sm text-muted-foreground">Staff takeaway and delivery orders are switched off for this restaurant.</p>
        {isManager(ctx.role) && (
          <Link href="/settings/takeaway-delivery" className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Turn them on
          </Link>
        )}
      </div>
    )
  }

  const [orders, menuItemRows, happyHourRows, menuItemGroupRows] = await Promise.all([
    withUser(ctx.user.id, (tx) => listActiveTypedOrdersCore(tx, ctx.tenant.id, branch.id)),
    listMenuItems(ctx),
    listHappyHours(ctx),
    listMenuItemModifierGroups(ctx),
  ])
  const modifierGroupsByItem = groupModifierGroupsByMenuItem(menuItemGroupRows)

  // Same shaping as the floor's order picker: hidden items never reach it,
  // out-of-stock ones show disabled.
  const orderable = menuItemRows.filter((i) => i.status !== 'hidden')
  const categoryMap = new Map<string, string>()
  for (const i of orderable) categoryMap.set(i.categoryId, i.categoryName)

  return (
    <TypedOrdersBoard
      branchId={branch.id}
      currency={ctx.tenant.currency}
      timeZone={ctx.tenant.timezone}
      takeawayEnabled={settings.takeawayEnabled}
      deliveryEnabled={settings.deliveryEnabled}
      defaultFee={settings.defaultDeliveryFee}
      feeTaxRate={settings.deliveryFeeTaxRate}
      categories={[...categoryMap.entries()].map(([id, name]) => ({ id, name }))}
      menuItems={orderable.map((i) => ({
        id: i.id,
        name: i.name,
        price: i.price,
        categoryId: i.categoryId,
        categoryName: i.categoryName,
        taxPercent: i.taxPercent,
        status: i.status,
        modifierGroups: modifierGroupsByItem.get(i.id) ?? [],
      }))}
      happyHours={happyHourRows.map((h) => ({
        id: h.id,
        name: h.name,
        daysOfWeek: h.daysOfWeek,
        startTime: h.startTime,
        endTime: h.endTime,
        discountType: h.discountType,
        discountValue: h.discountValue,
        isActive: h.isActive,
      }))}
      orders={orders.map((o) => ({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        orderType: o.orderType,
        channel: o.channel,
        stage: o.stage,
        createdAt: o.createdAt.toISOString(),
        pickupAt: o.pickupAt ? o.pickupAt.toISOString() : null,
        contactName: o.contactName,
        contactPhone: o.contactPhone,
        deliveryAddress: o.deliveryAddress,
        deliveryFee: o.deliveryFee,
        driverName: o.driverName,
        driverPhone: o.driverPhone,
        notes: o.notes,
        paid: o.paid,
        invoiceId: o.invoiceId,
        items: o.items,
      }))}
    />
  )
}
