import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** The tenant's primary branch — attendance hangs off a branch like resources/hours. */
export function getPrimaryBranch(ctx: ActiveContext) {
  return withUser(ctx.user.id, async (tx) => {
    const [branch] = await tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1)
    return branch ?? null
  })
}
