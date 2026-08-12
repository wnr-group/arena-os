import 'server-only'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { loadBusinessProfile, type BusinessProfile } from './business-profile'

/**
 * The tenant's business profile, in one RLS-scoped transaction — the same
 * ctx-taking reader shape as lib/customers/profile.ts and lib/billing/data.ts.
 *
 * The tenant comes from the authenticated context, never from client input, and
 * `business_select` scopes the read on top of that. Returns null when the
 * tenant has not configured a profile yet.
 */
export async function getBusinessProfile(ctx: ActiveContext): Promise<BusinessProfile | null> {
  return withUser(ctx.user.id, (tx) => loadBusinessProfile(tx, ctx.tenant.id))
}
