'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireOwner, AuthError } from '@/lib/auth/guard'
import { businessProfileSchema, upsertBusinessProfile } from '@/lib/settings/business-profile'
import { zodErrorMessage } from '@/lib/utils/errors'

type SaveResult = { error?: string; success?: true }

/** Same shape as the other actions — only safe text reaches the UI. */
function fail(e: unknown): SaveResult {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  console.error('[business-profile] save failed:', e)
  return { error: 'Could not save the business profile. Please try again.' }
}

/**
 * Create or update the tenant's business profile.
 *
 * Owner-only at BOTH layers: requireOwner() here, and the `business_write` RLS
 * policy (auth_role_in(tenant_id) = 'owner') in the database. Hiding the
 * sidebar entry is neither of those — a manager calling this action directly
 * still gets "Owners only."
 *
 * The client sends only the profile fields. `tenant_id` comes from the
 * authenticated context; nothing about identity or role is taken from input.
 */
export async function saveBusinessProfile(
  input: z.input<typeof businessProfileSchema>,
): Promise<SaveResult> {
  try {
    const ctx = await requireOwner()
    const v = businessProfileSchema.parse(input)

    await withUser(ctx.user.id, (tx) => upsertBusinessProfile(tx, ctx.tenant.id, v))

    revalidatePath('/settings/business')
    return { success: true }
  } catch (e) {
    return fail(e)
  }
}
