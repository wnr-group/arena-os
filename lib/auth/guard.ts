import 'server-only'
import { getActiveContext, type ActiveContext } from '@/lib/tenant/context'
import { isManager } from './roles'

/** Active tenant context or an Error (caller in an action returns the message). */
export async function requireContext(): Promise<ActiveContext> {
  const ctx = await getActiveContext()
  if (!ctx) throw new AuthError('Not signed in to this workspace.')
  return ctx
}

export async function requireManager(): Promise<ActiveContext> {
  const ctx = await requireContext()
  if (!isManager(ctx.role)) throw new AuthError('Only owners and managers can do this.')
  return ctx
}

export class AuthError extends Error {}
