'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { promoCodes } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { normalizePromoCode } from '@/lib/billing/promo'
import { zodErrorMessage } from '@/lib/utils/errors'

type Result = { error?: string }

/**
 * Postgres error code, dug out of however many wrappers sit on top of it.
 *
 * Drizzle re-throws driver errors wrapped in its own Error whose `message` is
 * just `Failed query: insert into …` — the SQLSTATE and constraint name live on
 * `cause`. Matching on message text (as some older actions here do) therefore
 * silently never fires, and a duplicate surfaces as a generic failure.
 */
function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const o = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof o.code === 'string') {
      return { code: o.code, constraint: typeof o.constraint === 'string' ? o.constraint : undefined }
    }
    cur = o.cause
  }
  return {}
}

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }

  const { code, constraint } = pgError(e)
  // 23505 = unique_violation. The index is on (tenant_id, upper(code)), so a
  // duplicate in ANY casing lands here.
  if (code === '23505') return { error: 'That promo code already exists.' }
  // 23514 = check_violation — the DB backstops the same rules Zod checks.
  if (code === '23514') {
    if (constraint === 'promo_valid_dates') return { error: 'The end date must be after the start date.' }
    if (constraint === 'promo_percentage_range') return { error: 'A percentage discount cannot exceed 100.' }
    return { error: 'Enter a discount of zero or more.' }
  }

  console.error('[promo-codes] action failed:', e)
  return { error: 'Could not save the promo code. Please try again.' }
}

/**
 * The management contract.
 *
 * `code` is normalised through the SAME helper billing uses to look codes up
 * (lib/billing/promo.ts), so what a manager types and what validatePromo()
 * later resolves can never drift apart.
 *
 * `uses`, `tenant_id`, `created_at` are deliberately absent: usage is owned by
 * the billing transaction, and the tenant comes from the session.
 */
const promoInput = z
  .object({
    id: z.string().uuid().optional(),
    code: z
      .string()
      .trim()
      .min(1, 'A promo code is required.')
      .max(32, 'Keep the code to 32 characters.')
      .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only.'),
    discountType: z.enum(['percentage', 'fixed'], {
      errorMap: () => ({ message: 'Choose a percentage or a fixed amount.' }),
    }),
    discountValue: z.coerce
      .number({ invalid_type_error: 'Enter a discount value.' })
      .finite('Enter a discount value.')
      .min(0, 'A discount cannot be negative.'),
    validFrom: z.coerce.date({ invalid_type_error: 'Enter a valid start date.' }),
    validUntil: z.coerce.date({ invalid_type_error: 'Enter a valid end date.' }),
    // '' from an empty form field means unlimited.
    maxUses: z
      .union([z.coerce.number().int().positive('A usage limit must be at least 1.'), z.null()])
      .optional(),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.validUntil > v.validFrom, {
    message: 'The end date must be after the start date.',
    path: ['validUntil'],
  })
  // Mirrors the promo_percentage_range CHECK: 150% is always a typo for ₹150.
  .refine((v) => v.discountType !== 'percentage' || v.discountValue <= 100, {
    message: 'A percentage discount cannot exceed 100.',
    path: ['discountValue'],
  })

/**
 * Create or edit a promo code. Manager-only at BOTH layers: requireManager()
 * here, and the promo_write RLS policy (auth_is_manager) in the database.
 *
 * On edit the `code` is left alone — it may already appear on issued invoices,
 * so renaming it would make history read wrong. `uses` is never in the update
 * set, so editing a limit can never reset the count.
 */
export async function upsertPromoCode(input: z.input<typeof promoInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = promoInput.parse(input)

    const code = normalizePromoCode(v.code)
    if (!code) return { error: 'A promo code is required.' }

    await withUser(ctx.user.id, async (tx) => {
      const values = {
        discountType: v.discountType,
        discountValue: v.discountValue.toFixed(2),
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        maxUses: v.maxUses ?? null,
        isActive: v.isActive,
      }
      if (v.id) {
        await tx
          .update(promoCodes)
          .set(values)
          .where(and(eq(promoCodes.id, v.id), eq(promoCodes.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(promoCodes).values({ tenantId: ctx.tenant.id, code, ...values })
      }
    })

    revalidatePath('/settings/promo-codes')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Expire (or re-activate) a code.
 *
 * Deactivating rather than deleting is deliberate: `invoices.promo_code_id`
 * points at these rows, and a bill must keep saying which promo it honoured.
 * validatePromo() refuses an inactive code immediately.
 */
export async function setPromoCodeActive(id: string, isActive: boolean): Promise<Result> {
  try {
    const ctx = await requireManager()
    const promoId = z.string().uuid('That promo reference is not valid.').parse(id)

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(promoCodes)
        .set({ isActive })
        .where(and(eq(promoCodes.id, promoId), eq(promoCodes.tenantId, ctx.tenant.id))),
    )

    revalidatePath('/settings/promo-codes')
    return {}
  } catch (e) {
    return fail(e)
  }
}
