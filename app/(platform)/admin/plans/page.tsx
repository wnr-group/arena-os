import { getCurrentUser } from '@/lib/auth/session'
import { listPlans } from '@/lib/platform/plans/data'
import { PlansManager } from '@/components/platform/PlansManager'

/**
 * The platform plan catalogue (M16).
 *
 * Same guard shape as AdminHome: the layout renders the "platform admins only"
 * screen, and this returns early so a non-admin's request never fetches the
 * catalogue into its RSC payload. listPlans() enforces the check again on the
 * server — that one is the actual boundary, this is for the payload.
 */
export default async function AdminPlansPage() {
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  const plans = await listPlans()
  return <PlansManager plans={plans} />
}
