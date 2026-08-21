import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listMembershipPlans } from '@/lib/membership-plans/data'
import { MembershipPlansManager } from '@/components/settings/MembershipPlansManager'

export default async function MembershipPlansSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — every mutation calls requireManager(), and
  // membership_plans_write is manager-only in RLS on top of that.
  if (!isManager(ctx.role)) redirect('/dashboard')

  const plans = await listMembershipPlans(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Membership Plans</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The plans customers can subscribe to — price, duration and benefits. Tenant-scoped and
        manager only.
      </p>
      <MembershipPlansManager
        currency={ctx.tenant.currency}
        plans={plans.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          durationMonths: p.durationMonths,
          discountPercent: p.discountPercent,
          freeHours: p.freeHours,
          walletCredit: p.walletCredit,
          isActive: p.isActive,
        }))}
      />
    </div>
  )
}
