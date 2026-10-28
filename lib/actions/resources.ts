'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import {
  resourceTypes,
  resources,
  resourceSetups,
  resourceSetupImages,
  holidayRates,
  workingHours,
  taxRates,
  businessProfiles,
} from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, checkLimitIn } from '@/lib/platform/entitlement-guard'
import { countResources, lockTenantUsage } from '@/lib/platform/usage'
import { uploadImage, deleteImage, validateUpload, sniffImageMime, IMAGE_POLICY } from '@/lib/storage/s3'
import { MAX_SETUP_IMAGES } from '@/lib/booking/setup-images'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { industryHasStudioSetups } from '@/lib/booking/studio-setups'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  // A plan refusal — its message already says what to do, like AuthError's.
  if (e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code, constraint } = pgError(e)
  if (code === '23505') {
    if (constraint === 'holiday_rates_resource_type_id_date_key') {
      return { error: 'This resource type already has a holiday rate set for that date.' }
    }
    return { error: 'That name is already in use.' }
  }
  // 23503 = foreign_key_violation (default NO ACTION); 23001 = restrict_violation
  // (explicit ON DELETE RESTRICT, which is what these FKs use) — both mean
  // "still referenced elsewhere."
  if (code === '23503' || code === '23001') {
    // Default Postgres FK naming: `<table>_<column>_fkey`.
    if (constraint === 'resources_resource_type_id_fkey') {
      return { error: 'This resource type is used by one or more resources. Remove or reassign those resources first.' }
    }
    if (constraint === 'booking_slots_resource_id_fkey') {
      return { error: 'This resource has existing bookings and cannot be deleted.' }
    }
    return { error: 'This is still in use elsewhere and cannot be deleted.' }
  }
  console.error('[resources] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

// ── resource types ───────────────────────────────────────────────────────────
const resourceTypeInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().trim().optional(),
  hourlyRate: z.coerce.number().min(0),
  // M22 #3: the weekend hourly rate — blank means "no weekend pricing", which
  // must land as null (same blank-means-null discipline as resourceInput's
  // hourlyRateOverride below), not 0 (a real, free weekend rate). z.null()
  // MUST come before z.coerce.number() in the union: z.coerce.number()
  // itself coerces a bare `null` to 0 (Number(null) === 0) and z.union tries
  // branches in order, so a number-first union would silently accept null as
  // 0 and never reach z.null() at all — the preprocess step alone doesn't
  // save it.
  weekendRate: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0)]),
    )
    .optional(),
  bufferMinutes: z.coerce.number().int().min(0).default(0),
  capacity: z.coerce.number().int().positive().optional(),
  color: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  taxRateId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
  // M21 per-head #3: 'per_resource' (default — today's rate × time billing,
  // unchanged) or 'per_head' (rate × players × time — see 0094_per_head_pricing.sql
  // and lib/booking/service.ts's priceBookingSlots).
  pricingMode: z.enum(['per_resource', 'per_head']).default('per_resource'),
  minPlayers: z.coerce.number().int().min(1).default(1),
  // M29 #2: board pricing — the base rate covers includedPlayers players and
  // each player beyond that adds extraPlayerRate per hour (blank/null = the
  // surcharge is off). Same null-before-coerce union as weekendRate above.
  includedPlayers: z.coerce.number().int().positive('Included players must be a whole number of at least 1.').max(1000, 'Included players is too large.').default(1),
  extraPlayerRate: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0, 'Extra player rate can’t be negative.')]),
    )
    .optional(),
  extraPlayerWeekendRate: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0, 'Extra player weekend rate can’t be negative.')]),
    )
    .optional(),
}).superRefine((v, ctx) => {
  const hasBase = v.extraPlayerRate !== null && v.extraPlayerRate !== undefined
  const hasWeekend = v.extraPlayerWeekendRate !== null && v.extraPlayerWeekendRate !== undefined
  // Hiding the fields in the form is a convenience; this is the guard.
  if (v.pricingMode === 'per_head' && (hasBase || hasWeekend)) {
    ctx.addIssue({
      code: 'custom',
      path: ['extraPlayerRate'],
      message: 'Extra-player pricing only applies to per-station types, not per-head types.',
    })
  }
  // A weekend extra rate falls back to the base extra rate — with no base rate
  // the surcharge is off and there is nothing to fall back from.
  if (hasWeekend && !hasBase) {
    ctx.addIssue({
      code: 'custom',
      path: ['extraPlayerWeekendRate'],
      message: 'Set an extra player rate before setting a weekend extra player rate.',
    })
  }
})

export async function upsertResourceType(input: z.input<typeof resourceTypeInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = resourceTypeInput.parse(input)
    const newImageUrl = v.imageUrl || null
    let oldImageUrl: string | null = null
    await withUser(ctx.user.id, async (tx) => {
      // taxRateId is a foreign key but not tenant-composite at the DB level —
      // re-check ownership + scope in this transaction, same discipline
      // upsertMenuItem (lib/actions/menu.ts) uses for its own taxRateId.
      if (v.taxRateId) {
        const [taxRate] = await tx
          .select({ id: taxRates.id, appliesTo: taxRates.appliesTo })
          .from(taxRates)
          .where(and(eq(taxRates.id, v.taxRateId), eq(taxRates.tenantId, ctx.tenant.id)))
          .limit(1)
        if (!taxRate) throw new AuthError('Choose a tax rate from this menu.')
        if (taxRate.appliesTo === 'food') {
          throw new AuthError('That tax rate only applies to food, not resources.')
        }
      }

      // Per-head pricing only ever means something for a timed, hourly
      // resource — a restaurant's table types are seated via
      // seatTableSessionCore, which never prices by time at all (see its own
      // "hourlyRate must be 0" convention), so a per_head mode there would be
      // a setting with no effect anywhere in the app. Gated here, not just in
      // the form, the same way a food-only tax rate is re-checked above.
      if (v.pricingMode === 'per_head' && ctx.tenant.industry === 'restaurant') {
        throw new AuthError('Per-head pricing isn’t available for restaurant table types.')
      }

      // Board extra-player pricing is a gaming_cafe feature (0105). Gated here,
      // not just by hiding the fields, same as the per-head gate above.
      const hasSurcharge = v.extraPlayerRate !== null && v.extraPlayerRate !== undefined
      if (hasSurcharge && ctx.tenant.industry !== 'gaming_cafe') {
        throw new AuthError('Extra-player pricing isn’t available for this business type.')
      }

      const values = {
        tenantId: ctx.tenant.id,
        name: v.name,
        description: v.description || null,
        hourlyRate: v.hourlyRate.toFixed(2),
        weekendRate: v.weekendRate === null || v.weekendRate === undefined ? null : v.weekendRate.toFixed(2),
        bufferMinutes: v.bufferMinutes,
        capacity: v.capacity ?? null,
        color: v.color || null,
        imageUrl: newImageUrl,
        taxRateId: v.taxRateId || null,
        isActive: v.isActive,
        pricingMode: v.pricingMode,
        minPlayers: v.minPlayers,
        // includedPlayers is meaningless for per_head (every player is billed).
        includedPlayers: v.pricingMode === 'per_head' ? 1 : v.includedPlayers,
        extraPlayerRate: hasSurcharge ? v.extraPlayerRate!.toFixed(2) : null,
        extraPlayerWeekendRate:
          hasSurcharge && v.extraPlayerWeekendRate !== null && v.extraPlayerWeekendRate !== undefined
            ? v.extraPlayerWeekendRate.toFixed(2)
            : null,
      }
      if (v.id) {
        const [existing] = await tx
          .select({ imageUrl: resourceTypes.imageUrl })
          .from(resourceTypes)
          .where(and(eq(resourceTypes.id, v.id), eq(resourceTypes.tenantId, ctx.tenant.id)))
          .limit(1)
        if (existing && existing.imageUrl !== newImageUrl) oldImageUrl = existing.imageUrl
        await tx
          .update(resourceTypes)
          .set(values)
          .where(and(eq(resourceTypes.id, v.id), eq(resourceTypes.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(resourceTypes).values(values)
      }
    })
    if (oldImageUrl) void deleteImage(oldImageUrl, ctx.tenant.id)
    revalidatePath('/settings/resources')
    // A type's own rate/pricingMode/minPlayers feed straight into the New
    // Booking wizard (listResources() joins resourceTypes) — without this,
    // switching a type to per_head here left the wizard showing stale data
    // (no Players field) until a hard reload, same reasoning upsertResource
    // below already applies to a single unit's own rate/status.
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteResourceType(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const [row] = await withUser(ctx.user.id, async (tx) => {
      const existing = await tx
        .select({ imageUrl: resourceTypes.imageUrl })
        .from(resourceTypes)
        .where(and(eq(resourceTypes.id, id), eq(resourceTypes.tenantId, ctx.tenant.id)))
        .limit(1)
      await tx.delete(resourceTypes).where(and(eq(resourceTypes.id, id), eq(resourceTypes.tenantId, ctx.tenant.id)))
      return existing
    })
    if (row) void deleteImage(row.imageUrl, ctx.tenant.id)
    revalidatePath('/settings/resources')
    return {}
  } catch (e) {
    return fail(e) // e.g. restrict violation if resources reference it
  }
}

// ── resource type image upload ─────────────────────────────────────────────
export async function uploadResourceTypeImage(formData: FormData): Promise<{ url?: string; error?: string }> {
  try {
    const ctx = await requireManager()
    const file = formData.get('file')
    if (!(file instanceof File)) return { error: 'No file provided.' }
    const url = await uploadImage(file, `tenants/${ctx.tenant.id}/resource-types`)
    return { url }
  } catch (e) {
    return fail(e)
  }
}

// ── resources ────────────────────────────────────────────────────────────────
const seatsField = z
  .preprocess((v) => (v === '' ? null : v), z.union([z.null(), z.coerce.number().int().min(1).max(100)]))
  .optional()
const resourceInput = z.object({
  id: z.string().uuid().optional(),
  branchId: z.string().uuid(),
  resourceTypeId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required'),
  // A BLANK override means "no override — use the type rate", which must land as
  // null. Guard the coercion: z.coerce.number('') is 0, not NaN, so without this
  // an empty string would silently store 0.00 and price the resource at ₹0
  // (`rate ?? typeRate` only falls back on null). Explicit 0 stays 0 (free).
  // z.null() MUST come before z.coerce.number() in the union below — see
  // resourceTypeInput's weekendRate above for why (a number-first union lets
  // z.coerce.number() itself silently coerce null to 0, defeating the guard).
  hourlyRateOverride: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0)]),
    )
    .optional(),
  status: z.enum(['available', 'maintenance', 'inactive']).default('available'),
  imageUrl: z.string().trim().optional(),
  description: z.string().trim().optional(),
  sortOrder: z.coerce.number().int().default(0),
  // Party sizes a table takes (restaurants). null = no limit on that side;
  // undefined = leave as stored, so callers that don't know about seats (every
  // non-restaurant form) never wipe them.
  minSeats: seatsField,
  maxSeats: seatsField,
}).refine((v) => !v.minSeats || !v.maxSeats || v.minSeats <= v.maxSeats, {
  message: 'Minimum seats can’t exceed maximum seats.',
  path: ['minSeats'],
})

export async function upsertResource(input: z.input<typeof resourceInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = resourceInput.parse(input)
    const newImageUrl = v.imageUrl || null
    let oldImageUrl: string | null = null
    await withUser(ctx.user.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        branchId: v.branchId,
        resourceTypeId: v.resourceTypeId,
        name: v.name,
        hourlyRateOverride:
          v.hourlyRateOverride === null || v.hourlyRateOverride === undefined
            ? null
            : v.hourlyRateOverride.toFixed(2),
        status: v.status,
        imageUrl: newImageUrl,
        description: v.description || null,
        sortOrder: v.sortOrder,
        ...(v.minSeats !== undefined && { minSeats: v.minSeats }),
        ...(v.maxSeats !== undefined && { maxSeats: v.maxSeats }),
      }
      if (v.id) {
        const [existing] = await tx
          .select({ imageUrl: resources.imageUrl })
          .from(resources)
          .where(and(eq(resources.id, v.id), eq(resources.tenantId, ctx.tenant.id)))
          .limit(1)
        if (existing && existing.imageUrl !== newImageUrl) oldImageUrl = existing.imageUrl
        await tx
          .update(resources)
          .set(values)
          .where(and(eq(resources.id, v.id), eq(resources.tenantId, ctx.tenant.id)))
      } else {
        // ── plan resource limit (M16 #2) ────────────────────────────────────
        // The insert branch only. Editing an existing resource must stay
        // possible for a tenant that is already at (or, after a downgrade,
        // over) its cap — the plan limits how many you own, not whether you
        // may correct one. Counted in THIS transaction, never from the client.
        //
        // The lock comes FIRST: count-then-insert is a check-then-act, and
        // concurrent creates would otherwise all clear the same count. See
        // lib/platform/usage.ts for the measurement that made this necessary.
        await lockTenantUsage(tx, ctx.tenant.id)
        await checkLimitIn(tx, ctx.tenant.id, 'max_resources', await countResources(tx, ctx.tenant.id), {
          one: 'resource',
          many: 'resources',
        })
        await tx.insert(resources).values(values)
      }
    })
    if (oldImageUrl) void deleteImage(oldImageUrl, ctx.tenant.id)
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteResource(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    const [row] = await withUser(ctx.user.id, async (tx) => {
      const existing = await tx
        .select({ imageUrl: resources.imageUrl })
        .from(resources)
        .where(and(eq(resources.id, id), eq(resources.tenantId, ctx.tenant.id)))
        .limit(1)
      // M35 #8: the setups' photo rows cascade away with the resource, so
      // their storage objects must be collected BEFORE the delete.
      const setupImages = await tx
        .select({ url: resourceSetupImages.url })
        .from(resourceSetupImages)
        .innerJoin(resourceSetups, eq(resourceSetups.id, resourceSetupImages.setupId))
        .where(and(eq(resourceSetups.resourceId, id), eq(resourceSetupImages.tenantId, ctx.tenant.id)))
      await tx.delete(resources).where(and(eq(resources.id, id), eq(resources.tenantId, ctx.tenant.id)))
      return existing.map((r) => ({ ...r, setupImageUrls: setupImages.map((i) => i.url) }))
    })
    if (row) {
      void deleteImage(row.imageUrl, ctx.tenant.id)
      await deleteImages(row.setupImageUrls, ctx.tenant.id)
    }
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── resource setups (M24 #3) ─────────────────────────────────────────────────
const resourceSetupInput = z.object({
  id: z.string().uuid().optional(),
  resourceId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required'),
  // Required and >= 0 — unlike hourlyRateOverride/weekendRate above (optional,
  // blank means "no override" -> null), a setup's rate IS the setup, so a
  // blank value must be REJECTED outright, not silently coerced to 0 the way
  // z.coerce.number('') would (Number('') === 0). Same blank-vs-zero trap
  // those optional fields guard against, opposite conclusion because this
  // one isn't optional: preprocess blank to null (their exact discipline),
  // then refine the null case away instead of accepting it.
  rate: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0, 'Enter a rate of 0 or more.')]),
    )
    .refine((v): v is number => v !== null, { message: 'Rate is required.' }),
  rateUnit: z.enum(['hour', 'day']).default('hour'),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
})

/**
 * Add/edit a named setup on a physical resource (M24 #3) — Kitchen,
 * Advertisement, Royal, etc. Setups are optional and share the resource's own
 * calendar: booking ANY setup blocks the whole physical set for that window,
 * for free, via the existing GiST exclusion on booking_slots (0003) keyed on
 * resource_id — nothing here needs to know that, it's just why a setup has
 * no time-window fields of its own.
 */
export async function upsertResourceSetup(input: z.input<typeof resourceSetupInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    // M24: Setups is scoped to a handful of studio-type industries — gated
    // here, not just by hiding the button in ResourcesManager, same
    // "hiding a button is convenience, never a guard" discipline
    // upsertResourceType's own per_head/restaurant gate above already
    // follows. gaming_cafe (and every other non-studio industry) keeps its
    // existing independent-unit resource model untouched.
    if (!industryHasStudioSetups(ctx.tenant.industry)) {
      throw new AuthError('Setups are not available for this type of business.')
    }
    const v = resourceSetupInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      // The resource this setup attaches to must belong to THIS tenant —
      // re-checked here, never trusted from the client, same discipline
      // upsertResourceType's taxRateId re-check uses for its own foreign id.
      const [resource] = await tx
        .select({ id: resources.id })
        .from(resources)
        .where(and(eq(resources.id, v.resourceId), eq(resources.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!resource) throw new AuthError('Resource not found.')

      const values = {
        tenantId: ctx.tenant.id,
        resourceId: v.resourceId,
        name: v.name,
        rate: v.rate.toFixed(2),
        rateUnit: v.rateUnit,
        isActive: v.isActive,
        sortOrder: v.sortOrder,
      }
      if (v.id) {
        await tx
          .update(resourceSetups)
          .set(values)
          .where(and(eq(resourceSetups.id, v.id), eq(resourceSetups.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(resourceSetups).values(values)
      }
    })
    revalidatePath('/settings/resources')
    // A setup feeds straight into the New Booking wizard's setup picker
    // (M24 #4) — same reasoning upsertResource/upsertResourceType already
    // apply to their own rate/status changes.
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteResourceSetup(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    // M35 #8: photo rows cascade with the setup; collect their storage URLs
    // first and remove the objects only after the DB delete has succeeded.
    const urls = await withUser(ctx.user.id, async (tx) => {
      const images = await tx
        .select({ url: resourceSetupImages.url })
        .from(resourceSetupImages)
        .where(and(eq(resourceSetupImages.setupId, id), eq(resourceSetupImages.tenantId, ctx.tenant.id)))
      await tx.delete(resourceSetups).where(and(eq(resourceSetups.id, id), eq(resourceSetups.tenantId, ctx.tenant.id)))
      return images.map((i) => i.url)
    })
    await deleteImages(urls, ctx.tenant.id)
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    revalidateSetupPages()
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── setup photos (M35 #8) ────────────────────────────────────────────────────
// Up to MAX_SETUP_IMAGES per setup; the cap is ALSO enforced by the database
// (CHECK position 1..3 + UNIQUE (setup_id, position), migration 0113), so the
// checks here are for friendly messages, never the only guard. Position 1 is
// the cover; positions are kept packed (1..n) so the cover is deterministic.

const SETUP_IMAGES_FULL = `A setup can have at most ${MAX_SETUP_IMAGES} photos. Remove one first.`

class SetupImageError extends Error {}

/** Best-effort removal of storage objects; deleteImage itself never throws and
 *  only ever deletes URLs that pass objectKeyFromUrl (our own bucket/base). */
async function deleteImages(urls: string[], tenantId: string): Promise<void> {
  await Promise.all(urls.map((u) => deleteImage(u, tenantId)))
}

function revalidateSetupPages() {
  revalidatePath('/resources')
  revalidatePath('/book/[resourceId]', 'page')
}

function failImage(e: unknown): Result {
  if (e instanceof SetupImageError) return { error: e.message }
  // Backstop: the race where two uploads both pass the app-level check.
  const { code } = pgError(e)
  if (code === '23505' || code === '23514') return { error: SETUP_IMAGES_FULL }
  // validateUpload's messages are user-safe by design (type / empty / size).
  if (e instanceof Error && /^(Only .* are allowed|The selected file is empty|Image must be smaller)/.test(e.message)) {
    return { error: e.message }
  }
  return fail(e)
}

/** The setup, tenant-scoped, locked FOR UPDATE: every photo write on one setup
 *  serialises here, so position assignment and the cap can't race. */
async function lockSetup(tx: Parameters<Parameters<typeof withUser>[1]>[0], tenantId: string, setupId: string) {
  const [setup] = await tx
    .select({ id: resourceSetups.id })
    .from(resourceSetups)
    .where(and(eq(resourceSetups.id, setupId), eq(resourceSetups.tenantId, tenantId)))
    .for('update')
  if (!setup) throw new SetupImageError('Setup not found.')
}

function requireStudio(industry: string) {
  if (!industryHasStudioSetups(industry)) throw new AuthError('Setups are not available for this type of business.')
}

export async function uploadSetupImage(
  setupId: string,
  formData: FormData,
): Promise<Result & { id?: string; url?: string; position?: number }> {
  let uploadedUrl: string | null = null
  let uploadTenantId: string | null = null
  try {
    const ctx = await requireManager()
    uploadTenantId = ctx.tenant.id
    requireStudio(ctx.tenant.industry)
    const id = z.string().uuid().parse(setupId)
    const file = formData.get('file')
    if (!(file instanceof File)) throw new SetupImageError('Choose an image to upload.')

    // Cheap pre-checks BEFORE touching storage: the setup is this tenant's and
    // there is room for another photo — no object is written for a doomed upload.
    const existingCount = await withUser(ctx.user.id, async (tx) => {
      const [setup] = await tx
        .select({ id: resourceSetups.id })
        .from(resourceSetups)
        .where(and(eq(resourceSetups.id, id), eq(resourceSetups.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!setup) throw new SetupImageError('Setup not found.')
      const rows = await tx
        .select({ id: resourceSetupImages.id })
        .from(resourceSetupImages)
        .where(eq(resourceSetupImages.setupId, id))
      return rows.length
    })
    if (existingCount >= MAX_SETUP_IMAGES) throw new SetupImageError(SETUP_IMAGES_FULL)

    // Type / size / empty first (extension comes from the MIME table, never the
    // filename), then the content itself: the declared type is only what the
    // browser guessed from the extension, so an HTML or script file renamed
    // .jpg would otherwise be stored and served as an "image".
    validateUpload(file, IMAGE_POLICY)
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
    if (sniffImageMime(head) !== file.type) {
      throw new SetupImageError('That file is not a valid JPEG, PNG, WEBP or GIF image.')
    }
    uploadedUrl = await uploadImage(file, `tenants/${ctx.tenant.id}/resource-setups/${id}`)
    const url = uploadedUrl

    const saved = await withUser(ctx.user.id, async (tx) => {
      await lockSetup(tx, ctx.tenant.id, id)
      const taken = new Set(
        (
          await tx
            .select({ position: resourceSetupImages.position })
            .from(resourceSetupImages)
            .where(eq(resourceSetupImages.setupId, id))
        ).map((r) => r.position),
      )
      let position = 0
      for (let p = 1; p <= MAX_SETUP_IMAGES; p++) {
        if (!taken.has(p)) {
          position = p
          break
        }
      }
      if (position === 0) throw new SetupImageError(SETUP_IMAGES_FULL)
      const [row] = await tx
        .insert(resourceSetupImages)
        .values({ tenantId: ctx.tenant.id, setupId: id, url, position })
        .returning({ id: resourceSetupImages.id, position: resourceSetupImages.position })
      return row
    })
    uploadedUrl = null // persisted — no longer an orphan candidate
    revalidatePath('/settings/resources')
    revalidateSetupPages()
    return { id: saved.id, url, position: saved.position }
  } catch (e) {
    // Rejected after the object was written (cap race, bad setup): don't leave an orphan.
    if (uploadedUrl && uploadTenantId) await deleteImages([uploadedUrl], uploadTenantId)
    return failImage(e)
  }
}

export async function removeSetupImage(imageId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    requireStudio(ctx.tenant.industry)
    const id = z.string().uuid().parse(imageId)
    const removedUrl = await withUser(ctx.user.id, async (tx) => {
      const [img] = await tx
        .select({ setupId: resourceSetupImages.setupId, url: resourceSetupImages.url })
        .from(resourceSetupImages)
        .where(and(eq(resourceSetupImages.id, id), eq(resourceSetupImages.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!img) throw new SetupImageError('Photo not found.')
      await lockSetup(tx, ctx.tenant.id, img.setupId)
      await tx
        .delete(resourceSetupImages)
        .where(and(eq(resourceSetupImages.id, id), eq(resourceSetupImages.tenantId, ctx.tenant.id)))
      // Re-pack to 1..n, lowest first: each target position was just freed by
      // the previous step, so the unique (setup_id, position) never trips and
      // position 1 is always the cover.
      const rest = await tx
        .select({ id: resourceSetupImages.id, position: resourceSetupImages.position })
        .from(resourceSetupImages)
        .where(eq(resourceSetupImages.setupId, img.setupId))
        .orderBy(asc(resourceSetupImages.position))
      for (const [i, r] of rest.entries()) {
        if (r.position !== i + 1) {
          await tx.update(resourceSetupImages).set({ position: i + 1 }).where(eq(resourceSetupImages.id, r.id))
        }
      }
      return img.url
    })
    await deleteImages([removedUrl], ctx.tenant.id)
    revalidatePath('/settings/resources')
    revalidateSetupPages()
    return {}
  } catch (e) {
    return failImage(e)
  }
}

const reorderInput = z.object({
  setupId: z.string().uuid(),
  orderedImageIds: z.array(z.string().uuid()).min(1).max(MAX_SETUP_IMAGES),
})

/** `orderedImageIds` must be EXACTLY this setup's photos, cover first. */
export async function reorderSetupImages(setupId: string, orderedImageIds: string[]): Promise<Result> {
  try {
    const ctx = await requireManager()
    requireStudio(ctx.tenant.industry)
    const v = reorderInput.parse({ setupId, orderedImageIds })
    await withUser(ctx.user.id, async (tx) => {
      await lockSetup(tx, ctx.tenant.id, v.setupId)
      const current = await tx
        .select()
        .from(resourceSetupImages)
        .where(and(eq(resourceSetupImages.setupId, v.setupId), eq(resourceSetupImages.tenantId, ctx.tenant.id)))
      const byId = new Map(current.map((r) => [r.id, r]))
      const sameSet =
        new Set(v.orderedImageIds).size === v.orderedImageIds.length &&
        v.orderedImageIds.length === current.length &&
        v.orderedImageIds.every((i) => byId.has(i))
      if (!sameSet) throw new SetupImageError('That photo list is out of date. Refresh and try again.')
      // UNIQUE (setup_id, position) is not deferrable, so moving rows between
      // positions in place would trip it. Rewrite the (at most 3) rows instead —
      // same ids, urls and timestamps, just new positions — in one transaction.
      await tx.delete(resourceSetupImages).where(inArray(resourceSetupImages.id, v.orderedImageIds))
      await tx
        .insert(resourceSetupImages)
        .values(v.orderedImageIds.map((imageId, i) => ({ ...byId.get(imageId)!, position: i + 1 })))
    })
    revalidatePath('/settings/resources')
    revalidateSetupPages()
    return {}
  } catch (e) {
    return failImage(e)
  }
}

// ── holiday rates (M27 #3) ────────────────────────────────────────────────────
const holidayRateInput = z.object({
  id: z.string().uuid().optional(),
  resourceTypeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.'),
  // Required and >= 0 — same blank-must-reject discipline resourceSetupInput's
  // rate uses above: a holiday rate IS the whole point of the entry, so a
  // blank value must be REJECTED outright, not silently coerced to 0.
  rate: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.union([z.null(), z.coerce.number().min(0, 'Enter a rate of 0 or more.')]),
    )
    .refine((v): v is number => v !== null, { message: 'Rate is required.' }),
})

/**
 * Add/edit a resource type's fixed rate for one calendar date (M27 #3) — a
 * public holiday, a festival, a one-off event. Not industry-gated, same as
 * weekend pricing: this is a sibling pricing axis on resourceTypes, visible
 * for every tenant.
 */
export async function upsertHolidayRate(input: z.input<typeof holidayRateInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = holidayRateInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      // The resource type must belong to THIS tenant — re-checked here,
      // never trusted from the client, same discipline upsertResourceSetup
      // above uses for its own resourceId.
      const [type] = await tx
        .select({ id: resourceTypes.id })
        .from(resourceTypes)
        .where(and(eq(resourceTypes.id, v.resourceTypeId), eq(resourceTypes.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!type) throw new AuthError('Resource type not found.')

      if (v.id) {
        // Editing a specific existing row. If the (possibly re-picked) date
        // now collides with a DIFFERENT row for this type, that is a genuine
        // ambiguity — surfaced as the friendly 23505 message in fail() above,
        // not silently merged into the other row.
        //
        // CodeRabbit review: the tenant-scoped WHERE can legitimately match
        // ZERO rows — the id belongs to another tenant, or the row was
        // deleted between the owner opening the edit form and saving it.
        // Without checking, this silently no-ops while the modal still
        // shows "Holiday rate updated." — a false success. .returning()
        // makes the zero-row case observable so it can fail loudly instead.
        const updated = await tx
          .update(holidayRates)
          .set({ resourceTypeId: v.resourceTypeId, date: v.date, rate: v.rate.toFixed(2) })
          .where(and(eq(holidayRates.id, v.id), eq(holidayRates.tenantId, ctx.tenant.id)))
          .returning({ id: holidayRates.id })
        if (updated.length === 0) throw new AuthError('Holiday rate not found.')
      } else {
        // Adding — the calendar-picker flow: the owner picks a type + date
        // and the UI pre-fills the existing rate if one is already set for
        // it (HolidayRatesModal), so re-saving an already-configured date is
        // the ordinary "update it" case, not an error — a clean upsert in
        // place, never a raw unique-constraint violation surfaced to the
        // owner for what is, from their side, just editing a value.
        await tx
          .insert(holidayRates)
          .values({ tenantId: ctx.tenant.id, resourceTypeId: v.resourceTypeId, date: v.date, rate: v.rate.toFixed(2) })
          .onConflictDoUpdate({
            target: [holidayRates.resourceTypeId, holidayRates.date],
            set: { rate: v.rate.toFixed(2) },
          })
      }
    })
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteHolidayRate(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(holidayRates).where(and(eq(holidayRates.id, id), eq(holidayRates.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── working hours ────────────────────────────────────────────────────────────
const dayInput = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^\d{2}:\d{2}$/),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/),
  isClosed: z.boolean(),
  open24h: z.boolean().default(false),
})
const hoursInput = z.object({
  branchId: z.string().uuid(),
  days: z.array(dayInput).length(7),
})

export async function saveWorkingHours(input: z.input<typeof hoursInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = hoursInput.parse(input)
    for (const d of v.days) {
      if (d.isClosed && d.open24h) {
        return { error: `A day can't be both closed and open 24 hours (day ${d.dayOfWeek}).` }
      }
      // open/close only matter for a normal (not closed, not 24h) day.
      if (!d.isClosed && !d.open24h && d.closeTime <= d.openTime) {
        return { error: `Close time must be after open time (day ${d.dayOfWeek}).` }
      }
    }
    await withUser(ctx.user.id, async (tx) => {
      for (const d of v.days) {
        await tx
          .insert(workingHours)
          .values({
            tenantId: ctx.tenant.id,
            branchId: v.branchId,
            dayOfWeek: d.dayOfWeek,
            openTime: d.openTime,
            closeTime: d.closeTime,
            isClosed: d.isClosed,
            open24h: d.open24h,
          })
          .onConflictDoUpdate({
            target: [workingHours.branchId, workingHours.dayOfWeek],
            set: { openTime: d.openTime, closeTime: d.closeTime, isClosed: d.isClosed, open24h: d.open24h },
          })
      }
    })
    revalidatePath('/settings/hours')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── weekend days (M22 #3) ────────────────────────────────────────────────────
// Manager-gated (not owner-only, unlike business-profile.ts's legal-identity
// fields — see requireOwner's own doc comment) since this is pricing
// configuration, the same authority level as a resource type's own rates.
const weekendDaysInput = z.array(z.number().int().min(0).max(6)).max(7)

/**
 * Which weekdays count as "weekend" for a resource type's weekend_rate
 * (M22 #3) — tenant-wide, in business_profiles.weekend_days, not per type.
 * An empty array is valid: it makes every type's weekend_rate a no-op
 * without having to clear each one individually.
 */
export async function saveWeekendDays(input: number[]): Promise<Result> {
  try {
    const ctx = await requireManager()
    const days = [...new Set(weekendDaysInput.parse(input))].sort((a, b) => a - b)
    await withUser(ctx.user.id, (tx) =>
      tx
        .insert(businessProfiles)
        .values({ tenantId: ctx.tenant.id, weekendDays: days })
        .onConflictDoUpdate({ target: businessProfiles.tenantId, set: { weekendDays: days } }),
    )
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}
