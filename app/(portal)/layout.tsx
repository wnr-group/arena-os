import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { requireCustomer } from '@/lib/auth/customer-guard'
import { customerSignOut } from '@/lib/actions/customer-auth'
import { getReviewPrompt } from '@/lib/portal/review-prompt'
import { PortalShell } from '@/components/portal/PortalShell'
import { GoogleReviewPrompt } from '@/components/portal/GoogleReviewPrompt'

/**
 * The AUTHENTICATED customer surface (AROS-88).
 *
 * A third route group beside app/(app) (staff, needs a membership) and
 * app/(public) (no login at all). It is deliberately its own group rather than
 * a subtree of either: the guard below must apply to everything inside it and
 * to nothing outside it, and a route group is the only way to say that
 * structurally rather than by remembering to call a guard on each page.
 *
 * Note what this file does NOT do: it never calls getCurrentUser() or
 * getActiveContext(). A staff session is not an identity here, and a customer
 * is not a member of anything. The two authentication systems meet nowhere.
 *
 * The login page lives in app/(public)/account/login precisely because it must
 * be reachable without a session — putting it inside this group would put it
 * behind the very guard it exists to satisfy.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // Tenant first: an unknown or suspended venue must 404 before the guard can
  // bounce anyone to a login page for a venue that does not exist.
  const slug = await currentTenantSlug()
  if (!slug) notFound()

  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  // Redirects to /account/login when the cookie is missing, expired, revoked,
  // or belongs to a different tenant. This is the real check — proxy.ts only
  // looks at whether a cookie is present.
  const customer = await requireCustomer()

  // The Google review ask (0105), decided entirely on the server: null unless
  // the venue enabled it, the link still validates, this customer has had a
  // successful session or order, and they have not already answered.
  //
  // Mounted HERE rather than on the pages, because a layout does not remount as
  // the customer moves between /account, /account/bookings and /account/wallet
  // — so the prompt appears when they ENTER the portal, not on every navigation
  // inside it, and every entry point gets it without knowing about it.
  const reviewPrompt = await getReviewPrompt(tenant.name)

  return (
    <PortalShell
      venueName={tenant.name}
      customerName={customer.name}
      customerPhone={customer.phone}
      signOutAction={customerSignOut}
    >
      {children}
      {reviewPrompt && (
        <GoogleReviewPrompt
          url={reviewPrompt.url}
          venueName={reviewPrompt.venueName}
          customerId={reviewPrompt.customerId}
        />
      )}
    </PortalShell>
  )
}
