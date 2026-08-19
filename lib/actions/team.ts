'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { memberships } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { findOrCreateUser } from '@/lib/platform/provision'
import type { MemberRole } from '@/lib/auth/roles'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  if (code === '23505') return { error: 'That person is already on the team.' }
  console.error('[team] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

const inviteInput = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().min(1, 'Name is required'),
  role: z.enum(['owner', 'manager', 'cashier', 'kitchen_staff', 'floor_staff', 'receptionist']),
  password: z.string().min(8).optional(),
})

export async function inviteStaff(input: z.input<typeof inviteInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = inviteInput.parse(input)

    // Only an owner may grant the owner role.
    if (v.role === 'owner' && ctx.role !== 'owner') {
      return { error: 'Only an owner can add another owner.' }
    }

    // Identity creation is privileged (owner connection); the membership write
    // below goes through RLS as the current manager.
    const { userId, created } = await findOrCreateUser({
      email: v.email,
      fullName: v.fullName,
      password: v.password,
    })
    if (created && !v.password) {
      return { error: 'This is a new person — set a temporary password for them.' }
    }

    await withUser(ctx.user.id, (tx) =>
      tx
        .insert(memberships)
        .values({
          tenantId: ctx.tenant.id,
          userId,
          branchId: ctx.branchId,
          role: v.role,
          status: 'active',
          fullName: v.fullName,
          email: v.email.toLowerCase(),
        })
        .onConflictDoUpdate({
          target: [memberships.tenantId, memberships.userId],
          set: { role: v.role, status: 'active', fullName: v.fullName, email: v.email.toLowerCase() },
        }),
    )

    revalidatePath('/settings/team')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// No session rotation needed on this privilege change: role is never cached
// in the cookie/session, only in the memberships row. getActiveContext()
// (lib/tenant/context.ts) re-reads it from the DB on every request via
// withUser()/RLS, so a demoted or promoted member's access changes on their
// very next request — there is no stale, session-bound privilege to revoke.
export async function updateMemberRole(membershipId: string, role: MemberRole): Promise<Result> {
  try {
    const ctx = await requireManager()
    if (membershipId === ctx.membershipId) return { error: 'You cannot change your own role.' }
    if (role === 'owner' && ctx.role !== 'owner') return { error: 'Only an owner can grant the owner role.' }

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/team')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function removeMember(membershipId: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    if (membershipId === ctx.membershipId) return { error: 'You cannot remove yourself.' }

    await withUser(ctx.user.id, (tx) =>
      tx.delete(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/team')
    return {}
  } catch (e) {
    return fail(e)
  }
}
