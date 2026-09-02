import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { isOtpBypassActive } from '@/lib/otp/config'
import { getCurrentCustomer } from '@/lib/auth/customer-session'
import { safeCustomerNext } from '@/lib/auth/customer-guard'
import { redirect } from 'next/navigation'
import { CustomerLoginForm } from '@/components/portal/CustomerLoginForm'

/**
 * Customer sign-in (AROS-87), now the door into the portal (AROS-88).
 *
 * Deliberately in the (public) route group rather than (portal): a login
 * screen is by definition reachable with no session, so putting it inside the
 * portal group would put it behind the guard it exists to satisfy. The group's
 * layout already pins it to the subdomain's tenant and 404s an unknown or
 * suspended venue, and proxy.ts exempts this exact path from BOTH session
 * gates.
 */
export default async function CustomerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const slug = await currentTenantSlug()
  if (!slug) notFound()

  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const { next } = await searchParams
  // Sanitised here, not in the browser: `next` arrives from the query string
  // and is attacker-controllable, so it is reduced to a known-safe in-portal
  // path before it can ever become a redirect target.
  const destination = safeCustomerNext(next)

  // Already signed in — skip the form. Also what makes the post-logout →
  // re-login loop terminate cleanly rather than showing a form to someone who
  // already has a valid session.
  const existing = await getCurrentCustomer()
  if (existing) redirect(destination)

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <CustomerLoginForm
          venueName={tenant.name}
          devBypassActive={isOtpBypassActive()}
          redirectTo={destination}
        />
      </div>
    </main>
  )
}
