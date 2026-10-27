import Link from 'next/link'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageWalkins, isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { listTables } from '@/lib/booking/data'
import { isWaitlistEnabled, listActiveWaitlist } from '@/lib/waitlist/data'
import { WaitlistView } from '@/components/waitlist/WaitlistView'

export default async function WaitlistPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Restaurant-only, plan-gated, front-of-house roles — same shape as /reservations.
  if (ctx.tenant.industry !== 'restaurant' || !canManageWalkins(ctx.role)) redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.waitlist'))) redirect('/floor')

  if (!(await isWaitlistEnabled(ctx))) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Waitlist</h1>
        <p className="mt-2 text-sm text-muted-foreground">The walk-in waitlist is switched off for this restaurant.</p>
        {isManager(ctx.role) && (
          <Link href="/settings/reservations" className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Turn on the waitlist
          </Link>
        )}
      </div>
    )
  }

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [entries, tables] = await Promise.all([listActiveWaitlist(ctx, branch.id), listTables(ctx, branch.id)])

  return (
    <WaitlistView
      branchId={branch.id}
      tables={tables.map((t) => ({ id: t.id, name: t.name, occupied: Boolean(t.bookingId) }))}
      entries={entries.map((e) => ({
        id: e.id,
        name: e.name,
        phone: e.phone,
        partySize: e.partySize,
        quotedWaitMinutes: e.quotedWaitMinutes,
        notes: e.notes,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
        notifiedAt: e.notifiedAt ? e.notifiedAt.toISOString() : null,
      }))}
    />
  )
}
