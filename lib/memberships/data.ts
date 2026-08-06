import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { memberships } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** Active staff for a tenant — the shared "pick a team member" source for attendance/roster/tasks. */
export function listActiveMembers(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: memberships.id,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        branchId: memberships.branchId,
      })
      .from(memberships)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.role), asc(memberships.fullName)),
  )
}
