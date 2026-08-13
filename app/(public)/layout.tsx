import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'

/**
 * The public (no-login) surface, pinned to whichever tenant the subdomain
 * names — proxy.ts forwards the host as x-tenant-slug for every request, but
 * never checks it carries a session (see the isPublicRoute exemption there).
 *
 * Unlike app/(app)/layout.tsx this never calls getActiveContext(): there is
 * no user, so tenant resolution goes through the public, RLS-gated lookup in
 * lib/tenant/public.ts instead. The root domain, an unknown subdomain, and a
 * suspended/cancelled tenant's subdomain all 404 the same way — nothing here
 * distinguishes "no such tenant" from "not open for booking".
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const slug = await currentTenantSlug()
  if (!slug) notFound()

  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  return <div className="min-h-screen bg-background text-foreground">{children}</div>
}
