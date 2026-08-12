import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { promoCodes } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * The tenant's promo codes — same ctx-taking reader shape as
 * lib/tax-rates/data.ts. The tenant comes from the authenticated context, never
 * from the client, and the promo_select RLS policy scopes the read again.
 */
export function listPromoCodes(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.tenantId, ctx.tenant.id))
      .orderBy(asc(promoCodes.code)),
  )
}
