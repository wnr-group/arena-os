import 'server-only'
import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug, type PublicTenant } from '@/lib/tenant/public'

/**
 * The venue a portal page is being rendered for.
 *
 * Portal pages need the tenant only for DISPLAY — its name, and above all its
 * timezone, since every booking instant is stored as timestamptz and has to be
 * rendered as the venue's wall clock rather than the viewer's. Authorisation
 * never comes from here; that is the customer session's job.
 *
 * Resolved through the same public, RLS-gated lookup the booking site uses, and
 * cached per request by getPublicTenantBySlug(), so calling this in a layout and
 * again in a page costs one query.
 */
export async function portalTenant(): Promise<PublicTenant> {
  const slug = await currentTenantSlug()
  if (!slug) notFound()

  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  return tenant
}
