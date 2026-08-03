import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getWorkingHours } from '@/lib/booking/data'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { WorkingHoursForm } from '@/components/settings/WorkingHoursForm'

export default async function HoursSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const existing = await getWorkingHours(ctx, branch.id)
  const byDay = new Map(existing.map((h) => [h.dayOfWeek, h]))

  const days = Array.from({ length: 7 }, (_, dow) => {
    const h = byDay.get(dow)
    return {
      dayOfWeek: dow,
      openTime: h?.openTime ?? '10:00',
      closeTime: h?.closeTime ?? '22:00',
      isClosed: h?.isClosed ?? false,
    }
  })

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Working hours</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        When <strong>{branch.name}</strong> is open. Availability for bookings is
        computed from these ({ctx.tenant.timezone}).
      </p>
      <WorkingHoursForm branchId={branch.id} initialDays={days} />
    </div>
  )
}
