'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, LogIn, LogOut, Pencil, Plus, Loader2, UserCheck, UserX, X } from 'lucide-react'
import { clockIn, clockOut, managerSaveAttendance, managerDeleteAttendance } from '@/lib/actions/attendance'
import { ROLE_LABELS, type MemberRole } from '@/lib/auth/roles'
import { timeInZone } from '@/lib/format'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type AttendanceRow = {
  membershipId: string
  fullName: string | null
  email: string | null
  role: MemberRole
  attendanceId: string | null
  clockIn: string | null
  clockOut: string | null
  isManual: boolean
  note: string | null
}
type Modal = { row?: AttendanceRow } | null

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

export function AttendanceView({
  workDate,
  timeZone,
  currentMembershipId,
  isManagerView,
  rows,
}: {
  workDate: string
  timeZone: string
  currentMembershipId: string
  isManagerView: boolean
  rows: AttendanceRow[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal>(null)

  const me = rows.find((r) => r.membershipId === currentMembershipId) ?? null

  const stats = useMemo(() => {
    const total = rows.length
    const present = rows.filter((r) => r.clockIn).length
    const complete = rows.filter((r) => r.clockIn && r.clockOut).length
    return { total, present, absent: total - present, complete }
  }, [rows])

  function run(fn: () => Promise<{ error?: string }>, onSuccess?: () => void) {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        router.refresh()
        onSuccess?.()
      }
    })
  }

  function handleClockIn() {
    run(() => clockIn())
  }
  function handleClockOut() {
    run(() => clockOut())
  }
  async function handleDelete(row: AttendanceRow) {
    if (!row.attendanceId) return
    const attendanceId = row.attendanceId
    await confirm({
      title: 'Delete this attendance entry?',
      confirmText: 'Delete',
      onConfirm: async () => {
        const r = await managerDeleteAttendance(attendanceId)
        if (r.error) setError(r.error)
        else router.refresh()
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* self clock in/out */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5 shadow-sm">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Your status today</p>
          {!me?.clockIn ? (
            <p className="mt-1 text-lg font-semibold">Not clocked in</p>
          ) : !me?.clockOut ? (
            <p className="mt-1 text-lg font-semibold text-emerald-600">
              Clocked in at {timeInZone(me.clockIn, timeZone)}
            </p>
          ) : (
            <p className="mt-1 text-lg font-semibold">
              {timeInZone(me.clockIn, timeZone)} – {timeInZone(me.clockOut, timeZone)}
            </p>
          )}
        </div>
        {!me?.clockIn ? (
          <button
            onClick={handleClockIn}
            disabled={pending}
            className={`${btn} inline-flex items-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          >
            {pending ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} Clock in
          </button>
        ) : !me?.clockOut ? (
          <button
            onClick={handleClockOut}
            disabled={pending}
            className={`${btn} inline-flex items-center gap-2 border`}
          >
            {pending ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />} Clock out
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-600">
            <UserCheck size={15} /> Done for today
          </span>
        )}
      </div>

      {isManagerView && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard icon={Clock} label="Total staff" value={stats.total} accent="bg-primary/10 text-primary" />
            <StatCard icon={UserCheck} label="Clocked in" value={stats.present} accent="bg-emerald-500/10 text-emerald-600" />
            <StatCard icon={UserX} label="Not clocked in" value={stats.absent} accent="bg-amber-500/10 text-amber-600" />
            <StatCard icon={UserCheck} label="Completed" value={stats.complete} accent="bg-muted text-muted-foreground" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
              Today&apos;s attendance
            </h2>
            <button
              onClick={() => setModal({})}
              className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            >
              <Plus size={16} /> Add / correct entry
            </button>
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-base">
                <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Staff</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Clock in</th>
                    <th className="px-4 py-3 font-medium">Clock out</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => (
                    <tr key={row.membershipId} className="transition hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium">{row.fullName || row.email || 'Unnamed'}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{ROLE_LABELS[row.role]}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.clockIn ? timeInZone(row.clockIn, timeZone) : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.clockOut ? timeInZone(row.clockOut, timeZone) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${
                            !row.clockIn
                              ? 'bg-muted text-muted-foreground'
                              : !row.clockOut
                                ? 'bg-emerald-500/10 text-emerald-600'
                                : 'bg-blue-500/10 text-blue-600'
                          }`}
                        >
                          {!row.clockIn ? 'Not clocked in' : !row.clockOut ? 'Clocked in' : 'Complete'}
                        </span>
                        {row.isManual && <span className="ml-1.5 text-xs text-muted-foreground">(manual)</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button className={btn} onClick={() => setModal({ row })} aria-label="Edit">
                            <Pencil size={16} />
                          </button>
                          {row.attendanceId && (
                            <button
                              className={`${btn} text-destructive`}
                              disabled={pending}
                              onClick={() => handleDelete(row)}
                              aria-label="Delete"
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {modal && (
        <CorrectionModal
          row={modal.row}
          workDate={workDate}
          rows={rows}
          pending={pending}
          run={run}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string | number
  accent: string
}) {
  return (
    <div className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110 ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function CorrectionModal({
  row,
  workDate,
  rows,
  pending,
  run,
  onClose,
}: {
  row?: AttendanceRow
  workDate: string
  rows: AttendanceRow[]
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void
  onClose: () => void
}) {
  const [membershipId, setMembershipId] = useState(row?.membershipId ?? rows[0]?.membershipId ?? '')
  const [date, setDate] = useState(workDate)
  const [clockInTime, setClockInTime] = useState(row?.clockIn ? row.clockIn.slice(11, 16) : '')
  const [clockOutTime, setClockOutTime] = useState(row?.clockOut ? row.clockOut.slice(11, 16) : '')
  const [note, setNote] = useState(row?.note ?? '')
  const [submitted, setSubmitted] = useState(false)

  const errors = useMemo(() => {
    const e: { membershipId?: string; times?: string } = {}
    if (!membershipId) e.membershipId = 'Select a staff member.'
    if (clockInTime && clockOutTime && clockOutTime <= clockInTime) e.times = 'Clock out must be after clock in.'
    return e
  }, [membershipId, clockInTime, clockOutTime])
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () =>
        managerSaveAttendance({
          id: row?.attendanceId ?? undefined,
          membershipId,
          workDate: date,
          clockIn: clockInTime || null,
          clockOut: clockOutTime || null,
          note: note || undefined,
        }),
      onClose,
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Correct entry' : 'Add entry'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Staff member</label>
            <select
              className={input}
              value={membershipId}
              onChange={(e) => setMembershipId(e.target.value)}
              disabled={!!row}
            >
              {rows.map((r) => (
                <option key={r.membershipId} value={r.membershipId}>
                  {r.fullName || r.email || 'Unnamed'} · {ROLE_LABELS[r.role]}
                </option>
              ))}
            </select>
            {submitted && errors.membershipId && <p className={errorText}>{errors.membershipId}</p>}
          </div>
          <div>
            <label className={label}>Date</label>
            <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Clock in</label>
              <input className={input} type="time" value={clockInTime} onChange={(e) => setClockInTime(e.target.value)} />
            </div>
            <div>
              <label className={label}>Clock out</label>
              <input className={input} type="time" value={clockOutTime} onChange={(e) => setClockOutTime(e.target.value)} />
            </div>
          </div>
          {submitted && errors.times && <p className={errorText}>{errors.times}</p>}
          <div>
            <label className={label}>Note (optional)</label>
            <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Forgot to clock out" />
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button className={`${btn} border`} disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
