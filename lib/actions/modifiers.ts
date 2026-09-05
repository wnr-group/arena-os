'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { modifierGroups, modifierOptions } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

/** Modifiers are a restaurant-only feature (M17 #8) — checked here, not just
 *  by hiding the nav entry/page, so the action refuses even a direct call
 *  from a non-restaurant tenant. */
async function requireRestaurantManager() {
  const ctx = await requireManager()
  if (ctx.tenant.industry !== 'restaurant') {
    throw new AuthError('Modifiers are only available for restaurant tenants.')
  }
  return ctx
}

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code, constraint } = pgError(e)
  if (code === '23505') return { error: 'That name is already in use.' }
  // 23503 = foreign_key_violation; 23001 = restrict_violation — both mean
  // "still referenced elsewhere," same mapping lib/actions/menu.ts uses.
  if (code === '23503' || code === '23001') {
    if (constraint === 'modifier_options_group_id_fkey') {
      return { error: 'Delete this group’s options first.' }
    }
    return { error: 'This is still in use elsewhere and cannot be deleted.' }
  }
  console.error('[modifiers] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

// ── groups ──────────────────────────────────────────────────────────────────
const groupInput = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Name is required').max(100),
    minSelect: z.coerce.number().int().min(0),
    maxSelect: z.coerce.number().int().min(1),
    required: z.boolean().default(false),
    sortOrder: z.coerce.number().int().default(0),
  })
  .refine((v) => v.maxSelect >= v.minSelect, { message: 'Max must be at least min.', path: ['maxSelect'] })

export async function upsertModifierGroup(input: z.input<typeof groupInput>): Promise<Result> {
  try {
    const ctx = await requireRestaurantManager()
    const v = groupInput.parse(input)
    const values = {
      tenantId: ctx.tenant.id,
      name: v.name,
      minSelect: v.minSelect,
      maxSelect: v.maxSelect,
      required: v.required,
      sortOrder: v.sortOrder,
    }
    await withUser(ctx.user.id, async (tx) => {
      if (v.id) {
        await tx
          .update(modifierGroups)
          .set(values)
          .where(and(eq(modifierGroups.id, v.id), eq(modifierGroups.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(modifierGroups).values(values)
      }
    })
    revalidatePath('/menu/modifiers')
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteModifierGroup(id: string): Promise<Result> {
  try {
    const ctx = await requireRestaurantManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(modifierGroups).where(and(eq(modifierGroups.id, id), eq(modifierGroups.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/menu/modifiers')
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── options ─────────────────────────────────────────────────────────────────
const optionInput = z.object({
  id: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required').max(100),
  // A modifier can be a surcharge (extra cheese, +30) or free (no onions, 0)
  // — never negative: a discount belongs in happy hours/promos, not a
  // per-item modifier.
  priceDelta: z.coerce.number().min(0),
  sortOrder: z.coerce.number().int().default(0),
})

export async function upsertModifierOption(input: z.input<typeof optionInput>): Promise<Result> {
  try {
    const ctx = await requireRestaurantManager()
    const v = optionInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      // groupId is a plain FK, not tenant-scoped at the DB level (same gap
      // upsertMenuItem's categoryId re-check closes) — verify ownership here.
      const [group] = await tx
        .select({ id: modifierGroups.id })
        .from(modifierGroups)
        .where(and(eq(modifierGroups.id, v.groupId), eq(modifierGroups.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!group) throw new AuthError('Choose a modifier group from this menu.')

      const values = {
        tenantId: ctx.tenant.id,
        groupId: v.groupId,
        name: v.name,
        priceDelta: v.priceDelta.toFixed(2),
        sortOrder: v.sortOrder,
      }
      if (v.id) {
        await tx
          .update(modifierOptions)
          .set(values)
          .where(and(eq(modifierOptions.id, v.id), eq(modifierOptions.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(modifierOptions).values(values)
      }
    })
    revalidatePath('/menu/modifiers')
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteModifierOption(id: string): Promise<Result> {
  try {
    const ctx = await requireRestaurantManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(modifierOptions).where(and(eq(modifierOptions.id, id), eq(modifierOptions.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/menu/modifiers')
    revalidatePath('/menu/items')
    return {}
  } catch (e) {
    return fail(e)
  }
}

