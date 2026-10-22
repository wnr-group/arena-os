'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import {
  InventoryError,
  createStockItemCore,
  recordMovementCore,
  setModifierRecipeCore,
  setRecipeCore,
  updateStockItemCore,
} from '@/lib/inventory/service'
import { MANUAL_MOVEMENT_TYPES } from '@/lib/inventory/rules'
import { zodErrorMessage } from '@/lib/utils/errors'

const MODULE = 'module.inventory'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof InventoryError || e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  if ((e as { cause?: { code?: string } })?.cause?.code === '23505') return { error: 'A stock item with that name already exists.' }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

type Ctx = Awaited<ReturnType<typeof requireManager>>

/** Owner/manager + plan with Inventory — enforced here, not by hiding the nav entry. */
async function run<T>(fn: (ctx: Ctx, actor: { tenantId: string; membershipId: string }) => Promise<T>): Promise<Result & { data?: T }> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, MODULE)
    const data = await fn(ctx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId })
    revalidatePath('/inventory')
    return { data }
  } catch (e) {
    return fail(e)
  }
}

const qty = z.coerce.number().finite()

const createInput = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1, 'Enter a name for the stock item.').max(80),
  unit: z.string().trim().min(1, 'Enter a unit.').max(20),
  reorderLevel: qty.min(0).default(0),
  openingQuantity: qty.min(0).optional(),
  unitCost: qty.min(0).nullable().optional(),
})

export async function createStockItem(input: z.input<typeof createInput>) {
  return run((ctx, a) => {
    const v = createInput.parse(input)
    return withUser(ctx.user.id, (tx) => createStockItemCore(tx, a, v))
  })
}

const updateInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(20),
  reorderLevel: qty.min(0),
  active: z.boolean(),
  /** number sets, null clears, omitted leaves the cost alone */
  unitCost: qty.min(0).nullable().optional(),
})

export async function updateStockItem(input: z.input<typeof updateInput>) {
  return run((ctx, a) => {
    const { id, ...rest } = updateInput.parse(input)
    return withUser(ctx.user.id, (tx) => updateStockItemCore(tx, a, id, rest))
  })
}

const movementInput = z.object({
  stockItemId: z.string().uuid(),
  type: z.enum(MANUAL_MOVEMENT_TYPES),
  amount: qty,
  reason: z.string().trim().max(200).optional(),
})

export async function recordStockMovement(input: z.input<typeof movementInput>) {
  return run((ctx, a) => {
    const v = movementInput.parse(input)
    return withUser(ctx.user.id, (tx) => recordMovementCore(tx, a, v))
  })
}

const recipeInput = z.object({
  menuItemId: z.string().uuid(),
  ingredients: z.array(z.object({ stockItemId: z.string().uuid(), quantity: qty })).max(50),
})

/** Replace a menu item's recipe; an empty list unlinks it (never deducted). */
export async function saveRecipe(input: z.input<typeof recipeInput>) {
  return run((ctx, a) => {
    const v = recipeInput.parse(input)
    return withUser(ctx.user.id, (tx) => setRecipeCore(tx, a, v.menuItemId, v.ingredients))
  })
}

const modifierRecipeInput = z.object({
  optionId: z.string().uuid(),
  ingredients: z.array(z.object({ stockItemId: z.string().uuid(), quantity: qty })).max(50),
})

/** Replace a modifier option's ingredients; an empty list unlinks it. */
export async function saveModifierRecipe(input: z.input<typeof modifierRecipeInput>) {
  return run((ctx, a) => {
    const v = modifierRecipeInput.parse(input)
    return withUser(ctx.user.id, (tx) => setModifierRecipeCore(tx, a, v.optionId, v.ingredients))
  })
}
