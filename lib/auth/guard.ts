import 'server-only'
import { getActiveContext, type ActiveContext } from '@/lib/tenant/context'
import { isManager, isOwner } from './roles'

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

/** Stricter than requireManager: the business's legal identity is owner-only. */
export async function requireOwner(): Promise<ActiveContext> {
  const ctx = await requireContext()
  if (!isOwner(ctx.role)) throw new AuthError('Owners only.')
  return ctx
}

export class AuthError extends Error {}
