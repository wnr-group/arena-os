'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { menuCategories, menuItems, taxRates, menuItemModifierGroups, modifierGroups } from '@/db/schema'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageKitchen } from '@/lib/auth/roles'
import { uploadImage, deleteImage } from '@/lib/storage/s3'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code, constraint } = pgError(e)
  if (code === '23505') return { error: 'That name is already in use.' }
  // 23503 = foreign_key_violation (default NO ACTION); 23001 = restrict_violation
  // (explicit ON DELETE RESTRICT, which is what this FK uses) — both mean
  // "still referenced elsewhere."
  if (code === '23503' || code === '23001') {
    // Default Postgres FK naming: `<table>_<column>_fkey`.
    if (constraint === 'menu_items_category_id_fkey') {
      return { error: 'This category has menu items in it. Move or delete those items first.' }
    }
    return { error: 'This is still in use elsewhere and cannot be deleted.' }
  }
  console.error('[menu] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

// ── categories ──────────────────────────────────────────────────────────────
const categoryInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
})

export async function upsertMenuCategory(input: z.input<typeof categoryInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = categoryInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      if (v.id) {
        await tx
          .update(menuCategories)
          .set({ name: v.name, sortOrder: v.sortOrder, isActive: v.isActive })
          .where(and(eq(menuCategories.id, v.id), eq(menuCategories.tenantId, ctx.tenant.id)))
      } else {
        // New categories always go to the end of the list — the client no
        // longer sends a meaningful sortOrder for creates, so relying on it
        // (or defaulting to 0) let every new row collide with whatever else
        // was already sitting at 0.
        const [{ next }] = await tx
          .select({ next: sql<number>`coalesce(max(${menuCategories.sortOrder}), -1) + 1` })
          .from(menuCategories)
          .where(eq(menuCategories.tenantId, ctx.tenant.id))
        await tx.insert(menuCategories).values({
          tenantId: ctx.tenant.id,
          name: v.name,
          isActive: v.isActive,
          sortOrder: next,
        })
      }
    })
    revalidatePath('/menu/categories')
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteMenuCategory(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(menuCategories).where(and(eq(menuCategories.id, id), eq(menuCategories.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/menu/categories')
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e) // restrict violation if items still reference this category
  }
}

// ── menu items ──────────────────────────────────────────────────────────────
const menuItemInput = z.object({
  id: z.string().uuid().optional(),
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().trim().optional(),
  price: z.coerce.number().min(0),
  taxRateId: z.string().uuid().nullable().optional(),
  status: z.enum(['available', 'out_of_stock', 'hidden']).default('available'),
  imageUrl: z.string().trim().optional(),
  sortOrder: z.coerce.number().int().default(0),
  // Modifier groups this item offers (M17 #8) — a size, add-ons, etc.
  // Optional: omit to leave existing links untouched (the modal always
  // sends the full current set, so in practice this is always present when
  // the caller is MenuItemsManager, but a script/test creating a plain item
  // shouldn't be forced to know about modifiers at all).
  modifierGroupIds: z.array(z.string().uuid()).optional(),
})

export async function upsertMenuItem(input: z.input<typeof menuItemInput>): Promise<Result & { id?: string }> {
  try {
    const ctx = await requireManager()
    const v = menuItemInput.parse(input)
    const itemId = await withUser(ctx.user.id, async (tx) => {
      // categoryId/taxRateId are foreign keys, but neither is scoped to
      // tenant_id at the DB level (menu_items.category_id is a plain FK to
      // menu_categories(id), not a composite (tenant_id, id) one) — any
      // *existing* uuid satisfies it, from any tenant. Re-check ownership
      // here, inside the same transaction, since getPublicMenu now publishes
      // every tenant's category ids on its no-login /food-menu page, making
      // a foreign category id trivial to obtain and plant on another
      // tenant's menu item otherwise.
      const [category] = await tx
        .select({ id: menuCategories.id })
        .from(menuCategories)
        .where(and(eq(menuCategories.id, v.categoryId), eq(menuCategories.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!category) throw new AuthError('Choose a category from this menu.')

      if (v.taxRateId) {
        const [taxRate] = await tx
          .select({ id: taxRates.id })
          .from(taxRates)
          .where(and(eq(taxRates.id, v.taxRateId), eq(taxRates.tenantId, ctx.tenant.id)))
          .limit(1)
        if (!taxRate) throw new AuthError('Choose a tax rate from this menu.')
      }

      const values = {
        tenantId: ctx.tenant.id,
        categoryId: v.categoryId,
        name: v.name,
        description: v.description || null,
        price: v.price.toFixed(2),
        taxRateId: v.taxRateId || null,
        status: v.status,
        imageUrl: v.imageUrl || null,
        sortOrder: v.sortOrder,
      }
      let id = v.id
      if (v.id) {
        await tx
          .update(menuItems)
          .set(values)
          .where(and(eq(menuItems.id, v.id), eq(menuItems.tenantId, ctx.tenant.id)))
      } else {
        const [created] = await tx.insert(menuItems).values(values).returning({ id: menuItems.id })
        id = created.id
      }

      // Full-replace the attached modifier groups, same as
      // lib/actions/modifiers.ts's own item-linking logic — the modal
      // always sends the complete current set, so delete-then-insert is
      // simpler and just as correct as diffing which links changed.
      // Modifiers are restaurant-only (M17 #8) — MenuItemsManager never
      // sends this field for another industry, but ignore it here too
      // rather than trusting the client.
      if (v.modifierGroupIds && ctx.tenant.industry === 'restaurant') {
        // group_id is a plain FK to modifier_groups(id), same un-tenant-scoped
        // shape as categoryId/taxRateId above — re-check ownership here too,
        // rather than trusting a client-supplied id straight into the link
        // table. Without this, an id from another tenant's modifier_groups
        // row satisfies the FK and RLS (menu_item_modifier_groups_write only
        // checks THIS row's own tenant_id, never the referenced group's) and
        // gets silently attached, leaking that tenant's group name/min/max
        // into this tenant's ordering flow (lib/orders/service.ts).
        if (v.modifierGroupIds.length > 0) {
          const owned = await tx
            .select({ id: modifierGroups.id })
            .from(modifierGroups)
            .where(and(inArray(modifierGroups.id, v.modifierGroupIds), eq(modifierGroups.tenantId, ctx.tenant.id)))
          if (owned.length !== new Set(v.modifierGroupIds).size) {
            throw new AuthError('Choose modifier groups from this menu.')
          }
        }
        await tx
          .delete(menuItemModifierGroups)
          .where(and(eq(menuItemModifierGroups.menuItemId, id!), eq(menuItemModifierGroups.tenantId, ctx.tenant.id)))
        if (v.modifierGroupIds.length > 0) {
          await tx.insert(menuItemModifierGroups).values(
            v.modifierGroupIds.map((groupId, i) => ({
              tenantId: ctx.tenant.id,
              menuItemId: id!,
              groupId,
              sortOrder: i,
            })),
          )
        }
      }

      return id
    })
    revalidatePath('/menu/items')
    return { id: itemId }
  } catch (e) {
    return fail(e)
  }
}

const availabilityInput = z.object({
  id: z.string().uuid(),
  status: z.enum(['available', 'out_of_stock']),
})

/**
 * "86" / un-86 an item — a fast toggle between available and out_of_stock
 * (M17 #7). Deliberately NOT requireManager(): the ticket wants "any
 * authorised staff" to flip this mid-service, which in practice means
 * kitchen staff and up — the same gate updateKotStatus uses
 * (lib/actions/kots.ts) — not the manager-only bar upsertMenuItem sets for
 * editing an item's price/name/etc.
 *
 * Never touches 'hidden': that's a stronger, deliberate manager decision
 * (menu settings), and this toggle has no business un-hiding an item or
 * hiding one just because it ran out — the WHERE clause below makes that
 * structurally impossible rather than trusting the caller not to ask.
 */
export async function setMenuItemAvailability(input: z.input<typeof availabilityInput>): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canManageKitchen(ctx.role)) {
      throw new AuthError('Only kitchen staff, managers and owners can 86 an item.')
    }
    const v = availabilityInput.parse(input)
    const updated = await withUser(ctx.user.id, (tx) =>
      tx
        .update(menuItems)
        .set({ status: v.status, updatedAt: new Date() })
        .where(and(eq(menuItems.id, v.id), eq(menuItems.tenantId, ctx.tenant.id), ne(menuItems.status, 'hidden')))
        .returning({ id: menuItems.id }),
    )
    if (updated.length === 0) return { error: 'Item not found, or it is hidden from the menu.' }
    revalidatePath('/menu/items')
    revalidatePath('/kitchen')
    revalidatePath('/floor')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteMenuItem(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const [row] = await withUser(ctx.user.id, async (tx) => {
      const existing = await tx
        .select({ imageUrl: menuItems.imageUrl })
        .from(menuItems)
        .where(and(eq(menuItems.id, id), eq(menuItems.tenantId, ctx.tenant.id)))
        .limit(1)
      await tx.delete(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.tenantId, ctx.tenant.id)))
      return existing
    })
    if (row) void deleteImage(row.imageUrl)
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── image upload ────────────────────────────────────────────────────────────
export async function uploadMenuItemImage(formData: FormData): Promise<{ url?: string; error?: string }> {
  try {
    const ctx = await requireManager()
    const file = formData.get('file')
    if (!(file instanceof File)) return { error: 'No file provided.' }
    const url = await uploadImage(file, `tenants/${ctx.tenant.id}/menu-items`)
    return { url }
  } catch (e) {
    return fail(e)
  }
}
