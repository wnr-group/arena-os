import { notFound } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { canViewCustomers, canBill } from '@/lib/auth/roles'
import { getCustomerProfile } from '@/lib/customers/profile'
import { CustomerProfile } from '@/components/customers/CustomerProfile'
import { listActiveMembershipPlans } from '@/lib/membership-plans/data'
import { isEligible } from '@/lib/memberships/customer-memberships'

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

  // Only plans still on sale can be sold. Eligibility is computed HERE, on the
  // server, from the same isEligible() the pricing path uses — the client never
  // re-derives it from `status` alone.
  const plans = await listActiveMembershipPlans(ctx)
  const now = new Date()

  return (
    <CustomerProfile
      data={data}
      timeZone={ctx.tenant.timezone}
      currency={ctx.tenant.currency}
      // Hides the controls for a role that cannot use them. The server actions
      // re-check this themselves — hiding a button is not authorization.
      canManage={canViewCustomers(ctx.role)}
      canSellMemberships={canBill(ctx.role)}
      memberships={data.memberships.map((m) => ({
        id: m.id,
        planName: m.planName,
        pricePaid: m.pricePaid,
        discountPercent: m.discountPercent,
        freeHours: m.freeHours,
        freeHoursUsed: m.freeHoursUsed,
        walletCredit: m.walletCredit,
        status: m.status,
        startsAt: m.startsAt.toISOString(),
        expiresAt: m.expiresAt.toISOString(),
        isEligible: isEligible(m, now),
      }))}
      membershipPlans={plans.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        durationMonths: p.durationMonths,
        discountPercent: p.discountPercent,
        freeHours: p.freeHours,
        walletCredit: p.walletCredit,
      }))}
    />
  )
}
