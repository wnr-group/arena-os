'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { branches, bookingAddons, resourceTypeAddons, resourceTypes, bookingSlots, resources } from '@/db/schema'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { BookingError } from '@/lib/booking/booking-error'
import { BillingError } from '@/lib/billing/invoice'
import {
  ADDON_MAX_QUANTITY,
  listAvailableAddons,
  listBookingAddons,
  lockAddonCatalog,
  peakReservedAddonUnits,
  setSlotAddonsCore,
  type AvailableAddon,
} from '@/lib/booking/addons'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof BookingError || e instanceof BillingError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const pg = pgError(e)
  if (pg?.code === '23505') return { error: 'This resource type already has an add-on with that name at this branch.' }
  console.error('[addons] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

// ── owner catalog CRUD ───────────────────────────────────────────────────────
const addonInput = z.object({
  id: z.string().uuid().optional(),
  resourceTypeId: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required.').max(80),
  // Required and >= 0 (free add-ons allowed) — a blank must be REJECTED, not coerced to a free
  // add-on (Number('') === 0); same discipline as resourceSetupInput.rate.
  rate: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0, 'Rate cannot be negative.')]),
    )
    .refine((v): v is number => v !== null, { message: 'Rate is required.' }),
  rateUnit: z.enum(['hour', 'day']).default('hour'),
  stockQuantity: z.coerce.number().int('Stock must be a whole number.').min(1, 'Stock must be at least 1.').max(100000),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
})

/**
 * Add/edit a priced add-on on a resource type at one branch. Not gated by
 * industry — any resource type, any industry (unlike Studio Setups). Editing
 * the rate/name never touches an existing booking: booking_addons carries its
 * own frozen snapshot.
 */
export async function upsertResourceTypeAddon(input: z.input<typeof addonInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = addonInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      // Both foreign ids re-checked against THIS tenant, never trusted.
      const [type] = await tx
        .select({ id: resourceTypes.id })
        .from(resourceTypes)
        .where(and(eq(resourceTypes.id, v.resourceTypeId), eq(resourceTypes.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!type) throw new AuthError('Resource type not found.')
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, v.branchId), eq(branches.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!branch) throw new AuthError('Branch not found.')

      const editable = {
        name: v.name,
        rate: v.rate.toFixed(2),
        rateUnit: v.rateUnit,
        stockQuantity: v.stockQuantity,
        isActive: v.isActive,
        sortOrder: v.sortOrder,
      }
      if (v.id) {
        // Type/branch stay immutable on edit: moving a catalog row would
        // orphan the stock accounting of live bookings.
        // Lock first so a concurrent attach can't slip in between the stock
        // check and the update.
        const locked = (await lockAddonCatalog(tx, ctx.tenant.id, [v.id])).get(v.id)
        if (!locked) throw new AuthError('Add-on not found.')
        if (v.stockQuantity < locked.stockQuantity) {
          const peak = await peakReservedAddonUnits(tx, ctx.tenant.id, v.id)
          if (v.stockQuantity < peak) {
            throw new BookingError(
              `${peak} unit${peak === 1 ? ' is' : 's are'} already reserved at once — stock can't go below ${peak}.`,
            )
          }
        }
        const updated = await tx
          .update(resourceTypeAddons)
          .set(editable)
          .where(and(eq(resourceTypeAddons.id, v.id), eq(resourceTypeAddons.tenantId, ctx.tenant.id)))
          .returning({ id: resourceTypeAddons.id })
        if (updated.length === 0) throw new AuthError('Add-on not found.')
      } else {
        await tx.insert(resourceTypeAddons).values({
          tenantId: ctx.tenant.id,
          branchId: v.branchId,
          resourceTypeId: v.resourceTypeId,
          ...editable,
        })
      }
    })
    revalidatePath('/settings/resources/types')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Delete a catalog entry — only one no booking has ever used. Anything with
 *  booking history must be deactivated instead (hidden going forward, history
 *  and stock accounting intact), so the UI offers Deactivate for those. The FK
 *  is ON DELETE SET NULL and would not block, which is why this is checked
 *  here. */
export async function deleteResourceTypeAddon(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const addonId = z.string().uuid().parse(id)
    await withUser(ctx.user.id, async (tx) => {
      const [used] = await tx
        .select({ id: bookingAddons.id })
        .from(bookingAddons)
        .where(and(eq(bookingAddons.addonId, addonId), eq(bookingAddons.tenantId, ctx.tenant.id)))
        .limit(1)
      if (used) throw new AuthError('This add-on has booking history — deactivate it instead of deleting.')
      await tx
        .delete(resourceTypeAddons)
        .where(and(eq(resourceTypeAddons.id, addonId), eq(resourceTypeAddons.tenantId, ctx.tenant.id)))
    })
    revalidatePath('/settings/resources/types')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── pickers (booking wizard / walk-in dialogs) ───────────────────────────────
const availabilityInput = z.object({
  branchId: z.string().uuid(),
  resourceIds: z.array(z.string().uuid()).min(1).max(50),
  startsAt: z.string().datetime(),
  /** Null/absent = an open tab (unbounded window). */
  endsAt: z.string().datetime().nullable().optional(),
})

/**
 * Active add-ons (with free units over the window) for each requested
 * resource, keyed by resourceId — what the pickers render. Read-only.
 */
export async function listAddonsForResources(
  input: z.input<typeof availabilityInput>,
): Promise<{ error?: string; byResource?: Record<string, AvailableAddon[]> }> {
  try {
    const ctx = await requireContext()
    const v = availabilityInput.parse(input)
    const byResource = await withUser(ctx.user.id, async (tx) => {
      const rs = await tx
        .select({ id: resources.id, resourceTypeId: resources.resourceTypeId, branchId: resources.branchId })
        .from(resources)
        .where(eq(resources.tenantId, ctx.tenant.id))
      const wanted = rs.filter((r) => v.resourceIds.includes(r.id) && r.branchId === v.branchId)
      const available = await listAvailableAddons(tx, ctx.tenant.id, {
        branchId: v.branchId,
        resourceTypeIds: [...new Set(wanted.map((r) => r.resourceTypeId))],
        startsAt: new Date(v.startsAt),
        endsAt: v.endsAt ? new Date(v.endsAt) : null,
      })
      const out: Record<string, AvailableAddon[]> = {}
      for (const r of wanted) out[r.id] = available.filter((a) => a.resourceTypeId === r.resourceTypeId)
      return out
    })
    return { byResource }
  } catch (e) {
    return fail(e)
  }
}

// ── post-creation edit tool ──────────────────────────────────────────────────
const setAddonsInput = z.object({
  bookingId: z.string().uuid(),
  bookingSlotId: z.string().uuid(),
  addons: z
    .array(z.object({ addonId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(ADDON_MAX_QUANTITY) }))
    .max(50),
})

/** Replace a slot's add-on set on an unbilled booking (add / remove / change
 *  qty). Every rule — unbilled, open, stock, snapshot — is enforced in
 *  setSlotAddonsCore, never here. */
export async function setBookingSlotAddons(input: z.input<typeof setAddonsInput>): Promise<Result> {
  try {
    const ctx = await requireContext()
    // Same roles as the other correction tools (undo check-in, reopen a tab,
    // fix an end time) — not a stricter gate. Re-checked here, never trusting
    // that the button was hidden.
    if (!canManageWalkins(ctx.role)) {
      throw new AuthError('You do not have permission to change add-ons.')
    }
    const v = setAddonsInput.parse(input)
    await withUser(ctx.user.id, (tx) =>
      setSlotAddonsCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/bookings')
    revalidatePath(`/pos/${v.bookingId}`)
    return {}
  } catch (e) {
    return fail(e)
  }
}

export type BookingAddonEditorSlot = {
  slotId: string
  resourceName: string
  current: { id: string; addonId: string | null; name: string; rateUnit: string; rateApplied: string; quantity: number }[]
  available: AvailableAddon[]
}

/** Everything the edit dialog needs for one booking: its slots, their current
 *  add-ons, and what's still available to add (excluding its own holdings). */
export async function loadBookingAddonEditor(
  bookingId: string,
): Promise<{ error?: string; slots?: BookingAddonEditorSlot[] }> {
  try {
    const ctx = await requireContext()
    const id = z.string().uuid().parse(bookingId)
    const slots = await withUser(ctx.user.id, async (tx) => {
      const slotRows = await tx
        .select({
          id: bookingSlots.id,
          resourceName: bookingSlots.resourceName,
          startsAt: bookingSlots.startsAt,
          endsAt: bookingSlots.endsAt,
          resourceTypeId: resources.resourceTypeId,
          branchId: resources.branchId,
        })
        .from(bookingSlots)
        .innerJoin(resources, eq(resources.id, bookingSlots.resourceId))
        .where(and(eq(bookingSlots.tenantId, ctx.tenant.id), eq(bookingSlots.bookingId, id), eq(bookingSlots.active, true)))
      const current = await listBookingAddons(tx, ctx.tenant.id, id)
      const out: BookingAddonEditorSlot[] = []
      for (const s of slotRows) {
        const available = await listAvailableAddons(tx, ctx.tenant.id, {
          branchId: s.branchId,
          resourceTypeIds: [s.resourceTypeId],
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          excludeBookingSlotId: s.id,
        })
        out.push({
          slotId: s.id,
          resourceName: s.resourceName,
          current: current
            .filter((c) => c.bookingSlotId === s.id)
            .map((c) => ({
              id: c.id,
              addonId: c.addonId,
              name: c.name,
              rateUnit: c.rateUnit,
              rateApplied: c.rateApplied,
              quantity: c.quantity,
            })),
          available,
        })
      }
      return out
    })
    return { slots }
  } catch (e) {
    return fail(e)
  }
}
