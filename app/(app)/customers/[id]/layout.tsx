import { notFound } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { customers } from '@/db/schema'
import { getActiveContext } from '@/lib/tenant/context'

/** Matches a UUID, so a junk id 404s without reaching the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Existence check for the profile segment.
 * id exists somewhere, which is itself a leak.
 */
export default async function CustomerProfileLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const ctx = await getActiveContext()
  if (!ctx) return <>{children}</>

  const [found] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, ctx.tenant.id), eq(customers.id, id)))
      .limit(1),
  )
  if (!found) notFound()

  return <>{children}</>
}
