import { getCurrentCustomerProfile } from '@/lib/portal/profile'
import { CustomerProfileForm } from '@/components/portal/CustomerProfileForm'

/**
 * Profile & preferences.
 *
 * Sits inside app/(portal), so PortalLayout's requireCustomer() has already
 * validated the session and redirected an unauthenticated visitor to
 * /account/login before this renders. The reader takes no arguments — it
 * resolves the customer from that same session.
 */
export default async function PortalProfilePage() {
  const profile = await getCurrentCustomerProfile()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your details and how this venue contacts you.
        </p>
      </div>

      <CustomerProfileForm initial={profile} />
    </div>
  )
}
