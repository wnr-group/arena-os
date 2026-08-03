import { redirect } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { memberships } from '@/db/schema'
import { TeamManager } from '@/components/settings/TeamManager'

export default async function TeamPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const members = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: memberships.id,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .where(eq(memberships.tenantId, ctx.tenant.id))
      .orderBy(asc(memberships.role), asc(memberships.fullName)),
  )

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Team</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Owners and staff at {ctx.tenant.name}. Add people and set what they can do.
      </p>
      <TeamManager
        members={members}
        currentMembershipId={ctx.membershipId}
        currentRole={ctx.role}
      />
    </div>
  )
}
