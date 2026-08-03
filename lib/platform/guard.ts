import 'server-only'
import { getCurrentUser, type CurrentUser } from '@/lib/auth/session'

export class PlatformError extends Error {}

/**
 * Require a signed-in PLATFORM admin (the SaaS operator). This is the trust tier
 * above all tenants; callers here legitimately act cross-tenant via the owner
 * connection. Throws PlatformError if not signed in or not a platform admin.
 */
export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw new PlatformError('Not signed in.')
  if (!user.isPlatformAdmin) throw new PlatformError('Platform administrators only.')
  return user
}
