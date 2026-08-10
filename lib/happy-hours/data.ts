import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { happyHours } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export function listHappyHours(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx.select().from(happyHours).where(eq(happyHours.tenantId, ctx.tenant.id)).orderBy(asc(happyHours.name)),
  )
}
