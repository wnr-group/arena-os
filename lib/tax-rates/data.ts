import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { taxRates } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export function listTaxRates(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx.select().from(taxRates).where(eq(taxRates.tenantId, ctx.tenant.id)).orderBy(asc(taxRates.name)),
  )
}
