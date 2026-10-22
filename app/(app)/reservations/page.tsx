import Link from 'next/link'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageWalkins, isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { listTables } from '@/lib/booking/data'
import { todayInZone } from '@/lib/booking/time'
import { dayBounds, getReservationSettings, listReservations } from '@/lib/reservations/data'
import { ReservationsView } from '@/components/reservations/ReservationsView'

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Restaurant-only, plan-gated, floor roles — same shape as /floor and /kitchen/expo.
  if (ctx.tenant.industry !== 'restaurant' || !canManageWalkins(ctx.role)) redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.table_reservations'))) redirect('/floor')

  const settings = await getReservationSettings(ctx)
  if (!settings.enabled) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Reservations</h1>
        <p className="mt-2 text-sm text-muted-foreground">Table reservations are switched off for this restaurant.</p>
        {isManager(ctx.role) && (
          <Link
            href="/settings/reservations"
            className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Turn on reservations
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

  const today = todayInZone(ctx.tenant.timezone)
  const { date: dateParam } = await searchParams
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today

  const [rows, tables] = await Promise.all([
    listReservations(ctx, branch.id, dayBounds(date, ctx.tenant.timezone)),
    listTables(ctx, branch.id),
  ])

  return (
    <ReservationsView
      branchId={branch.id}
      timeZone={ctx.tenant.timezone}
      date={date}
      today={today}
      graceMinutes={settings.noShowGraceMinutes}
      isManager={isManager(ctx.role)}
      tables={tables.map((t) => ({ id: t.id, name: t.name, occupied: Boolean(t.bookingId) }))}
      reservations={rows.map((r) => ({
        bookingId: r.bookingId,
        bookingNumber: r.bookingNumber,
        status: r.status,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        partySize: r.partySize,
        reservedFor: r.reservedFor.toISOString(),
        reservedMinutes: r.reservedMinutes,
        tableId: r.tableId,
        tableName: r.tableName,
        seatedTableId: r.seatedTableId,
        source: r.source,
        notes: r.notes,
      }))}
    />
  )
}
