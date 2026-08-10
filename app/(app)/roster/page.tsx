import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getPrimaryBranch } from '@/lib/attendance/data'
import { listActiveMembers } from '@/lib/memberships/data'
import { listRosterShifts, listMyShifts } from '@/lib/roster/data'
import { upsertRoster } from '@/lib/actions/roster'
import { addDays } from '@/lib/booking/data'
import { todayInZone, weekdayInZone } from '@/lib/booking/time'
import { RosterView } from '@/components/roster/RosterView'

export default async function RosterPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : todayInZone(tz)
  const dow = weekdayInZone(anchor, tz) // 0=Sun..6=Sat
  const weekStart = addDays(anchor, -((dow + 6) % 7)) // Monday on/before `anchor`

  const manager = isManager(ctx.role)
  const branch = await getPrimaryBranch(ctx)
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const members = await listActiveMembers(ctx)

  let rosterId: string | null = null
  let shifts: Awaited<ReturnType<typeof listRosterShifts>> = []
  if (manager) {
    const r = await upsertRoster({ branchId: branch.id, weekStart })
    if (r.id) {
      rosterId = r.id
      shifts = await listRosterShifts(ctx, r.id)
    }
  }
  const myShifts = manager ? [] : await listMyShifts(ctx, weekStart)
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i))

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Roster</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {branch.name} · Weekly shift schedule — tenant &amp; branch scoped.
      </p>
      <RosterView
        days={days}
        prevDate={addDays(weekStart, -7)}
        nextDate={addDays(weekStart, 7)}
        today={todayInZone(tz)}
        isManagerView={manager}
        rosterId={rosterId}
        members={members.map((m) => ({ id: m.id, name: m.fullName || m.email || 'Unnamed', role: m.role }))}
        shifts={shifts.map((s) => ({
          id: s.id,
          membershipId: s.membershipId,
          memberName: s.memberName,
          memberRole: s.memberRole,
          shiftDate: s.shiftDate,
          type: s.type,
          starts: s.starts,
          ends: s.ends,
        }))}
        myShifts={myShifts.map((s) => ({
          id: s.id,
          shiftDate: s.shiftDate,
          type: s.type,
          starts: s.starts,
          ends: s.ends,
        }))}
      />
    </div>
  )
}
