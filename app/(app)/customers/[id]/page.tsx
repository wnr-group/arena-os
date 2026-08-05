import { notFound } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { getCustomerProfile } from '@/lib/customers/profile'
import { CustomerProfile } from '@/components/customers/CustomerProfile'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const { id } = await params
  if (!UUID.test(id)) notFound()

  const data = await getCustomerProfile(ctx, id)
  if (!data) notFound()

  return (
    <CustomerProfile data={data} timeZone={ctx.tenant.timezone} currency={ctx.tenant.currency} />
  )
}
