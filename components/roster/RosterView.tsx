'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import { saveShift, deleteShift } from '@/lib/actions/roster'
import { ROLE_LABELS, type MemberRole } from '@/lib/auth/roles'
import { prettyDate } from '@/lib/format'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type ShiftType = 'morning' | 'evening' | 'night'
type Member = { id: string; name: string; role: MemberRole }
type RosterShift = {
  id: string
  membershipId: string
  memberName: string | null
  memberRole: MemberRole
  shiftDate: string
  type: ShiftType
  starts: string
  ends: string
}
type MyShift = { id: string; shiftDate: string; type: ShiftType; starts: string; ends: string }
type Modal = { date: string } | null

const TYPE_LABEL: Record<ShiftType, string> = { morning: 'Morning', evening: 'Evening', night: 'Night' }
const TYPE_STYLE: Record<ShiftType, string> = {
  morning: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  evening: 'border-blue-500/30 bg-blue-500/10 text-blue-600',
  night: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600',
}
const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

function formatTime(t: string) {
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

export function RosterView({
  days,
  prevDate,
  nextDate,
  today,
  isManagerView,
  rosterId,
  members,
  shifts,
  myShifts,
}: {
  days: string[]
  prevDate: string
  nextDate: string
  today: string
  isManagerView: boolean
  rosterId: string | null
  members: Member[]
  shifts: RosterShift[]
  myShifts: MyShift[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal>(null)

  const shiftsByDay = useMemo(() => {
    const map = new Map<string, RosterShift[]>()
    for (const s of shifts) {
      const list = map.get(s.shiftDate) ?? []
      list.push(s)
      map.set(s.shiftDate, list)
    }
    return map
  }, [shifts])

  const myShiftsByDay = useMemo(() => {
    const map = new Map<string, MyShift[]>()
    for (const s of myShifts) {
      const list = map.get(s.shiftDate) ?? []
      list.push(s)
      map.set(s.shiftDate, list)
    }
    return map
  }, [myShifts])

  async function handleDelete(id: string) {
    await confirm({
      title: 'Remove this shift?',
      confirmText: 'Remove',
      onConfirm: async () => {
        setError(null)
        const r = await deleteShift(id)
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {prettyDate(days[0], 'UTC')} – {prettyDate(days[6], 'UTC')}
        </p>
        <div className="flex items-center gap-2">
          <Link href={`/roster?date=${prevDate}`} className="rounded-md border p-2 hover:bg-muted" aria-label="Previous week">
            <ChevronLeft size={16} />
          </Link>
          <Link href={`/roster?date=${today}`} className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
            This week
          </Link>
          <Link href={`/roster?date=${nextDate}`} className="rounded-md border p-2 hover:bg-muted" aria-label="Next week">
            <ChevronRight size={16} />
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-7">
        {days.map((day) => {
          const dayShifts = isManagerView ? (shiftsByDay.get(day) ?? []) : (myShiftsByDay.get(day) ?? [])
          const isToday = day === today
          return (
            <div key={day} className={`rounded-xl border p-3 ${isToday ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{prettyDate(day, 'UTC').replace(/, \d{4}$/, '')}</p>
                {isManagerView && rosterId && (
                  <button
                    onClick={() => setModal({ date: day })}
                    className="text-muted-foreground hover:text-primary"
                    aria-label={`Add shift on ${day}`}
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
              <div className="mt-2 space-y-1.5">
                {dayShifts.length === 0 && <p className="text-xs text-muted-foreground">No shifts</p>}
                {isManagerView
                  ? (dayShifts as RosterShift[]).map((s) => (
                      <div key={s.id} className={`rounded-lg border px-2.5 py-2 text-xs ${TYPE_STYLE[s.type]}`}>
                        <div className="flex items-start justify-between gap-1">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{s.memberName || 'Unnamed'}</p>
                            <p className="truncate opacity-80">{ROLE_LABELS[s.memberRole]}</p>
                          </div>
                          <button onClick={() => handleDelete(s.id)} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Remove shift">
                            <X size={13} />
                          </button>
                        </div>
                        <p className="mt-1">
                          {TYPE_LABEL[s.type]} · {formatTime(s.starts)}–{formatTime(s.ends)}
                        </p>
                      </div>
                    ))
                  : (dayShifts as MyShift[]).map((s) => (
                      <div key={s.id} className={`rounded-lg border px-2.5 py-2 text-xs ${TYPE_STYLE[s.type]}`}>
                        <p className="font-medium">{TYPE_LABEL[s.type]}</p>
                        <p className="mt-0.5">
                          {formatTime(s.starts)}–{formatTime(s.ends)}
                        </p>
                      </div>
                    ))}
              </div>
            </div>
          )
        })}
      </div>

      {modal && rosterId && (
        <ShiftModal
          date={modal.date}
          rosterId={rosterId}
          members={members}
          pending={pending}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            router.refresh()
          }}
          onError={setError}
          start={start}
        />
      )}
    </div>
  )
}

function ShiftModal({
  date,
  rosterId,
  members,
  pending,
  onClose,
  onSaved,
  onError,
  start,
}: {
  date: string
  rosterId: string
  members: Member[]
  pending: boolean
  onClose: () => void
  onSaved: () => void
  onError: (msg: string | null) => void
  start: (fn: () => Promise<void>) => void
}) {
  const [membershipId, setMembershipId] = useState(members[0]?.id ?? '')
  const [type, setType] = useState<ShiftType>('morning')
  const [starts, setStarts] = useState('09:00')
  const [ends, setEnds] = useState('17:00')
  const [submitted, setSubmitted] = useState(false)

  const errors = useMemo(() => {
    const e: { membershipId?: string; times?: string } = {}
    if (!membershipId) e.membershipId = 'Select a staff member.'
    if (ends <= starts) e.times = 'End time must be after the start time.'
    return e
  }, [membershipId, starts, ends])
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    onError(null)
    start(async () => {
      const r = await saveShift({ rosterId, membershipId, shiftDate: date, type, starts, ends })
      if (r.error) onError(r.error)
      else onSaved()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Add shift</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{prettyDate(date, 'UTC')}</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Staff member</label>
            <select className={input} value={membershipId} onChange={(e) => setMembershipId(e.target.value)}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {ROLE_LABELS[m.role]}
                </option>
              ))}
            </select>
            {submitted && errors.membershipId && <p className={errorText}>{errors.membershipId}</p>}
          </div>
          <div>
            <label className={label}>Shift type</label>
            <select className={input} value={type} onChange={(e) => setType(e.target.value as ShiftType)}>
              <option value="morning">Morning</option>
              <option value="evening">Evening</option>
              <option value="night">Night</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Starts</label>
              <input className={input} type="time" value={starts} onChange={(e) => setStarts(e.target.value)} />
            </div>
            <div>
              <label className={label}>Ends</label>
              <input className={input} type="time" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </div>
          </div>
          {submitted && errors.times && <p className={errorText}>{errors.times}</p>}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Saving…' : 'Add shift'}
          </button>
          <button className={`${btn} border`} disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
