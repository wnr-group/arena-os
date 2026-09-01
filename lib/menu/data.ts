import 'server-only'
import { and, asc, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import {
  menuCategories,
  menuItems,
  orderItems,
  orders,
  taxRates,
  modifierGroups,
  modifierOptions,
  menuItemModifierGroups,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export { listTaxRates } from '@/lib/tax-rates/data'

export function listMenuCategories(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(menuCategories)
      .where(eq(menuCategories.tenantId, ctx.tenant.id))
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name)),
  )
}

/** Menu items joined with their category name and (optional) tax rate. */
export function listMenuItems(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: menuItems.id,
        name: menuItems.name,
        description: menuItems.description,
        price: menuItems.price,
        status: menuItems.status,
        imageUrl: menuItems.imageUrl,
        sortOrder: menuItems.sortOrder,
        categoryId: menuItems.categoryId,
        categoryName: menuCategories.name,
        taxRateId: menuItems.taxRateId,
        taxRateName: taxRates.name,
        taxPercent: taxRates.percent,
      })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .leftJoin(taxRates, eq(taxRates.id, menuItems.taxRateId))
      .where(eq(menuItems.tenantId, ctx.tenant.id))
      .orderBy(asc(menuItems.categoryId), asc(menuItems.sortOrder), asc(menuItems.name)),
  )
}

/**
 * Every modifier group + its options (M17 #8), tenant-wide — the menu
 * settings "Modifiers" page, and reusable wherever the full catalogue (not
 * scoped to one item) is needed. Flat rows, one per (group, option) pair —
 * a group with no options yet still has one row (optionId null) via the
 * left join.
 */
export function listModifierGroups(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        groupId: modifierGroups.id,
        groupName: modifierGroups.name,
        minSelect: modifierGroups.minSelect,
        maxSelect: modifierGroups.maxSelect,
        required: modifierGroups.required,
        groupSortOrder: modifierGroups.sortOrder,
        optionId: modifierOptions.id,
        optionName: modifierOptions.name,
        priceDelta: modifierOptions.priceDelta,
        optionSortOrder: modifierOptions.sortOrder,
      })
      .from(modifierGroups)
      .leftJoin(modifierOptions, eq(modifierOptions.groupId, modifierGroups.id))
      .where(eq(modifierGroups.tenantId, ctx.tenant.id))
      .orderBy(
        asc(modifierGroups.sortOrder),
        asc(modifierGroups.name),
        asc(modifierOptions.sortOrder),
        asc(modifierOptions.name),
      ),
  )
}

/**
 * Which modifier groups are attached to which menu items — just the link,
 * for MenuItemsManager's ItemModal checkbox list (pre-check + save the
 * attached set). See listMenuItemModifierGroups below for the fuller,
 * option-detail version the order-taking screens need.
 */
export function listMenuItemModifierGroupLinks(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({ menuItemId: menuItemModifierGroups.menuItemId, groupId: menuItemModifierGroups.groupId })
      .from(menuItemModifierGroups)
      .where(eq(menuItemModifierGroups.tenantId, ctx.tenant.id)),
  )
}

/**
 * Every menu item's attached modifier groups, with full option detail — what
 * the waiter fast-order screen (TakeOrderDialog) needs to prompt for
 * required choices before an item can be added to the cart. Tenant-wide in
 * one query rather than per-item, same "read once, match in memory" shape
 * as listMostOrderedItemIds below.
 */
export function listMenuItemModifierGroups(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        menuItemId: menuItemModifierGroups.menuItemId,
        itemGroupSortOrder: menuItemModifierGroups.sortOrder,
        groupId: modifierGroups.id,
        groupName: modifierGroups.name,
        minSelect: modifierGroups.minSelect,
        maxSelect: modifierGroups.maxSelect,
        required: modifierGroups.required,
        optionId: modifierOptions.id,
        optionName: modifierOptions.name,
        priceDelta: modifierOptions.priceDelta,
        optionSortOrder: modifierOptions.sortOrder,
      })
      .from(menuItemModifierGroups)
      .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.groupId))
      .leftJoin(modifierOptions, eq(modifierOptions.groupId, modifierGroups.id))
      .where(eq(menuItemModifierGroups.tenantId, ctx.tenant.id))
      .orderBy(
        asc(menuItemModifierGroups.sortOrder),
        asc(modifierGroups.sortOrder),
        asc(modifierOptions.sortOrder),
        asc(modifierOptions.name),
      ),
  )
}

export type MenuItemModifierGroupShape = {
  id: string
  name: string
  minSelect: number
  maxSelect: number
  required: boolean
  options: { id: string; name: string; priceDelta: string }[]
}

/**
 * Reshape listMenuItemModifierGroups' flat rows into menuItemId → its
 * attached groups (each with its options nested) — what TakeOrderDialog's
 * MenuItemOption.modifierGroups expects. A plain in-memory regroup, same
 * "one query, group in JS" shape app/(app)/kitchen/page.tsx already uses for
 * KOT tickets.
 */
export function groupModifierGroupsByMenuItem(
  rows: Awaited<ReturnType<typeof listMenuItemModifierGroups>>,
): Map<string, MenuItemModifierGroupShape[]> {
  const byItem = new Map<string, MenuItemModifierGroupShape[]>()
  for (const row of rows) {
    const groups = byItem.get(row.menuItemId) ?? []
    if (groups.length === 0) byItem.set(row.menuItemId, groups)
    let group = groups.find((g) => g.id === row.groupId)
    if (!group) {
      group = {
        id: row.groupId,
        name: row.groupName,
        minSelect: row.minSelect,
        maxSelect: row.maxSelect,
        required: row.required,
        options: [],
      }
      groups.push(group)
    }
    if (row.optionId) {
      group.options.push({ id: row.optionId, name: row.optionName!, priceDelta: row.priceDelta! })
    }
  }
  return byItem
}

/**
 * The branch's top ordered menu items over a trailing window — the "Popular"
 * quick-add row on the fast-order screen (M17 #3), so a waiter can fire the
 * usual round without searching or hunting through categories. Excludes
 * cancelled orders (never actually served) but otherwise counts every
 * channel, staff and online alike.
 */
export function listMostOrderedItemIds(
  ctx: ActiveContext,
  branchId: string,
  opts: { limit?: number; sinceDays?: number } = {},
) {
  const limit = opts.limit ?? 8
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 24 * 60 * 60 * 1000)
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        menuItemId: orderItems.menuItemId,
        totalQty: sql<number>`sum(${orderItems.qty})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenant.id),
          eq(orders.branchId, branchId),
          ne(orders.status, 'cancelled'),
          gte(orders.createdAt, since),
        ),
      )
      .groupBy(orderItems.menuItemId)
      .orderBy(desc(sql`sum(${orderItems.qty})`))
      .limit(limit),
  )
}
