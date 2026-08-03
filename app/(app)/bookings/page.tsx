import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listResources, getWorkingHours, listDayBookings, addDays } from '@/lib/booking/data'
import { todayInZone, weekdayInZone } from '@/lib/booking/time'
import { BookingsView } from '@/components/bookings/BookingsView'

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : todayInZone(tz)

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [allResources, hours, slots] = await Promise.all([
    listResources(ctx, branch.id),
    getWorkingHours(ctx, branch.id),
    listDayBookings(ctx, branch.id, date, tz),
  ])

  const dow = weekdayInZone(date, tz)
  const dayHours = hours.find((h) => h.dayOfWeek === dow)
  const closed = dayHours?.isClosed ?? false
  const openMin = dayHours && !dayHours.isClosed ? toMinutes(dayHours.openTime) : 600
  const closeMin = dayHours && !dayHours.isClosed ? toMinutes(dayHours.closeTime) : 1320

  const resources = allResources
    .filter((r) => r.status !== 'inactive')
    .map((r) => ({ id: r.id, name: r.name, typeName: r.typeName, status: r.status }))

  return (
    <BookingsView
      branchId={branch.id}
      branchName={branch.name}
      timeZone={tz}
      currency={ctx.tenant.currency}
      date={date}
      prevDate={addDays(date, -1)}
      nextDate={addDays(date, 1)}
      today={todayInZone(tz)}
      closed={closed}
      openMin={openMin}
      closeMin={closeMin}
      resources={resources}
      slots={slots.map((s) => ({
        slotId: s.slotId,
        resourceId: s.resourceId,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        bookingId: s.bookingId,
        bookingNumber: s.bookingNumber,
        customerName: s.customerName,
        customerPhone: s.customerPhone,
        status: s.status,
        source: s.source,
        total: s.total,
      }))}
    />
  )
}
