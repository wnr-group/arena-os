'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withCustomer } from '@/db'
import { getCurrentCustomer } from '@/lib/auth/customer-session'
import { ProfileError, profileSchema, updateOwnProfile } from '@/lib/portal/profile'
import { zodErrorMessage } from '@/lib/utils/errors'

/**
 * Customer profile & preferences (portal).
 *
 * Same shape as the staff actions (see lib/actions/business-profile.ts): parse
 * with Zod, do the work inside one scoped transaction, revalidate, return a
 * flat result. What differs is the identity:
 *
 *   getCurrentCustomer()   ← httpOnly cookie, validated against
 *                             customer_sessions AND this subdomain's tenant
 *        ↓
 *   withCustomer(id)       ← RLS narrows `customers` to that one row
 *        ↓
 *   customer_update_profile()  ← reads current_customer_id() itself, and can
 *                                only write name/email/sms_opt_in/email_opt_in
 *
 * The client sends four values. No customer id, no tenant id and no phone
 * crosses the wire, and none of the three could be honoured if it did.
 */

type SaveResult = { success?: true; error?: string }

/** Only safe text reaches the UI — the same rule the staff actions follow. */
function fail(e: unknown): SaveResult {
  if (e instanceof ProfileError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  console.error('[customer-profile] save failed:', e)
  return { error: 'Could not save your profile. Please try again.' }
}

export async function saveCustomerProfile(
  input: z.input<typeof profileSchema>,
): Promise<SaveResult> {
  try {
    const customer = await getCurrentCustomer()
    if (!customer) {
      // The layout guard redirects long before this, but an action is its own
      // entry point — a POST does not have to come from a page we rendered.
      return { error: 'Please sign in again to update your profile.' }
    }

    await withCustomer(customer.id, (tx) => updateOwnProfile(tx, input))

    revalidatePath('/account/profile')
    // The shell header shows the customer's name, so the whole portal is stale.
    revalidatePath('/account')

    return { success: true }
  } catch (e) {
    return fail(e)
  }
}
