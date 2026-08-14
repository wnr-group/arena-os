'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { menuCategories, menuItems } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
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
      const values = { tenantId: ctx.tenant.id, name: v.name, sortOrder: v.sortOrder, isActive: v.isActive }
      if (v.id) {
        await tx
          .update(menuCategories)
          .set(values)
          .where(and(eq(menuCategories.id, v.id), eq(menuCategories.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(menuCategories).values(values)
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
})

export async function upsertMenuItem(input: z.input<typeof menuItemInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = menuItemInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
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
      if (v.id) {
        await tx
          .update(menuItems)
          .set(values)
          .where(and(eq(menuItems.id, v.id), eq(menuItems.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(menuItems).values(values)
      }
    })
    revalidatePath('/menu/items')
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
