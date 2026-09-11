'use client'

import { useEffect, useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Clock, CheckCircle2, XCircle, Percent, Loader2, PauseCircle, PlayCircle } from 'lucide-react'
import { upsertHappyHour, deleteHappyHour } from '@/lib/actions/happy-hours'
import { activeHappyHours } from '@/lib/happy-hours/apply'
import { formatMoney } from '@/lib/format'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { STAT_TINT_CLASSES, type StatTint } from '@/lib/ui/statTint'

type DiscountType = 'percentage' | 'fixed'
type HappyHourRow = {
  id: string
  name: string
  daysOfWeek: number[]
  startTime: string
  endTime: string
  discountType: DiscountType
  discountValue: string
  isActive: boolean
}
type Modal = { mode: 'add' } | { mode: 'edit'; row: HappyHourRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void, onSettled?: () => void) => void

const DOW_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'
const NAME_PATTERN = /^[\p{L}\p{N} &'.,()-]+$/u

function formatTime(t: string) {
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function formatDiscount(type: DiscountType, value: string, currency: string) {
  return type === 'percentage' ? `${Number(value)}% off` : `${formatMoney(value, currency)} off`
}

/**
 * Live status of a rule right now: `disabled` when a manager has turned it
 * off (overrides the schedule, e.g. to stop it early), otherwise `live` or
 * `scheduled` based on whether `now` falls inside its days/time window.
 */
type Status = 'live' | 'scheduled' | 'disabled'

function getStatus(row: HappyHourRow, now: Date, timezone: string): Status {
  if (!row.isActive) return 'disabled'
  return activeHappyHours([row], now, timezone).length > 0 ? 'live' : 'scheduled'
}

const STATUS_META: Record<Status, { label: string; className: string; icon: ComponentType<{ size?: number }> }> = {
  live: { label: 'Live now', className: 'bg-emerald-500/10 text-emerald-600', icon: CheckCircle2 },
  scheduled: { label: 'Scheduled', className: 'bg-amber-500/10 text-amber-600', icon: Clock },
  disabled: { label: 'Disabled', className: 'bg-muted text-muted-foreground', icon: XCircle },
}

export function HappyHoursManager({
  currency,
  timezone,
  happyHours,
}: {
  currency: string
  timezone: string
  happyHours: HappyHourRow[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // Re-derive live/scheduled status on a timer so a rule flips to "Live now"
  // or "Scheduled" on its own as the clock crosses its start/end time.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  const run: Run = (fn, onSuccess, onSettled) => {
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        router.refresh()
        onSuccess?.()
      }
      onSettled?.()
    })
  }

  const stats = useMemo(() => {
    const total = happyHours.length
    const live = happyHours.filter((h) => getStatus(h, now, timezone) === 'live').length
    const disabled = happyHours.filter((h) => !h.isActive).length
    const percentage = happyHours.filter((h) => h.discountType === 'percentage').length
    return { total, live, disabled, percentage }
  }, [happyHours, now, timezone])

  async function applyToggle(row: HappyHourRow, next: boolean) {
    setTogglingId(row.id)
    const r = await upsertHappyHour({
      id: row.id,
      name: row.name,
      daysOfWeek: row.daysOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      discountType: row.discountType,
      discountValue: Number(row.discountValue),
      isActive: next,
    })
    setTogglingId(null)
    if (r.error) toast.error(r.error)
    else router.refresh()
  }

  async function handleToggleActive(row: HappyHourRow) {
    const next = !row.isActive
    if (!next) {
      await confirm({
        title: `Stop "${row.name}" now?`,
        description: 'It will no longer apply, even during its scheduled window, until you re-enable it.',
        confirmText: 'Stop it',
        onConfirm: () => applyToggle(row, next),
      })
    } else {
      applyToggle(row, next)
    }
  }

  async function handleDelete(row: HappyHourRow) {
    await confirm({
      title: `Delete happy hour "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteHappyHour(row.id)
        setDeletingId(null)
        if (r.error) toast.error(r.error)
        else router.refresh()
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Clock} label="Total rules" value={stats.total} tint="rose" />
        <StatCard icon={CheckCircle2} label="Live now" value={stats.live} tint="mint" />
        <StatCard icon={XCircle} label="Disabled" value={stats.disabled} tint="slate" />
        <StatCard icon={Percent} label="Percentage-based" value={stats.percentage} tint="rose" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">All happy hours</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={16} /> Add Happy Hour
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Days</th>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Discount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {happyHours.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-base text-muted-foreground">
                    No happy hours yet. Add one to get started.
                  </td>
                </tr>
              )}
              {happyHours.map((row) => {
                const status = getStatus(row, now, timezone)
                const meta = STATUS_META[status]
                const StatusIcon = meta.icon
                return (
                  <tr key={row.id} className="transition hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium">{row.name}</td>
                    <td className="px-4 py-3">
                      <DaySummary days={row.daysOfWeek} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatTime(row.startTime)} – {formatTime(row.endTime)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDiscount(row.discountType, row.discountValue, currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-medium ${meta.className}`}
                      >
                        <StatusIcon size={13} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          className={btn}
                          disabled={pending || togglingId === row.id}
                          onClick={() => handleToggleActive(row)}
                          aria-label={row.isActive ? 'Disable' : 'Enable'}
                          title={row.isActive ? 'Stop now' : 'Enable'}
                        >
                          {togglingId === row.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : row.isActive ? (
                            <PauseCircle size={16} />
                          ) : (
                            <PlayCircle size={16} />
                          )}
                        </button>
                        <button
                          className={btn}
                          disabled={pending}
                          onClick={() => setModal({ mode: 'edit', row })}
                          aria-label="Edit"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className={`${btn} text-destructive`}
                          disabled={pending}
                          onClick={() => handleDelete(row)}
                          aria-label="Delete"
                        >
                          {deletingId === row.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <HappyHourModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          currency={currency}
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
  tint,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  value: string | number
  tint: StatTint
}) {
  const { card, icon } = STAT_TINT_CLASSES[tint]
  return (
    <div className={`group rounded-xl border p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md sm:p-5 ${card}`}>
      <div className="inline-flex size-9 items-center justify-center rounded-lg bg-white transition-transform duration-300 group-hover:scale-110">
        <Icon size={18} className={icon} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function DaySummary({ days }: { days: number[] }) {
  return (
    <div className="flex gap-1">
      {DOW_SHORT.map((d, i) => (
        <span
          key={i}
          title={DOW_FULL[i]}
          className={`flex size-6 items-center justify-center rounded-full text-[10px] font-semibold ${
            days.includes(i) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
          }`}
        >
          {d[0]}
        </span>
      ))}
    </div>
  )
}

function HappyHourModal({
  row,
  currency,
  pending,
  run,
  onClose,
}: {
  row?: HappyHourRow
  currency: string
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(row?.daysOfWeek ?? [])
  const [startTime, setStartTime] = useState(row?.startTime?.slice(0, 5) ?? '17:00')
  const [endTime, setEndTime] = useState(row?.endTime?.slice(0, 5) ?? '19:00')
  const [discountType, setDiscountType] = useState<DiscountType>(row?.discountType ?? 'percentage')
  const [discountValue, setDiscountValue] = useState(row?.discountValue ?? '')
  const [isActive, setIsActive] = useState(row?.isActive ?? true)
  const [submitted, setSubmitted] = useState(false)

  const errors = useMemo(() => {
    const e: { name?: string; days?: string; time?: string; discountValue?: string } = {}
    const trimmedName = name.trim()
    if (!trimmedName) e.name = 'Name is required.'
    else if (trimmedName.length < 2) e.name = 'Name must be at least 2 characters.'
    else if (trimmedName.length > 100) e.name = 'Name must be at most 100 characters.'
    else if (!NAME_PATTERN.test(trimmedName))
      e.name = "Name can only contain letters, numbers, spaces, and & - ' . , ( )"
    if (daysOfWeek.length === 0) e.days = 'Select at least one day.'
    if (startTime && endTime && endTime <= startTime) e.time = 'End time must be after start time.'
    if (discountValue === '') e.discountValue = 'Discount value is required.'
    else if (Number.isNaN(Number(discountValue))) e.discountValue = 'Enter a valid number.'
    else if (Number(discountValue) < 0) e.discountValue = "Discount can't be negative."
    else if (discountType === 'percentage' && Number(discountValue) > 100) e.discountValue = 'Cannot exceed 100%.'
    return e
  }, [name, daysOfWeek, startTime, endTime, discountType, discountValue])
  const isValid = Object.keys(errors).length === 0

  function toggleDay(dow: number) {
    setDaysOfWeek((ds) => (ds.includes(dow) ? ds.filter((d) => d !== dow) : [...ds, dow].sort()))
  }

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () =>
        upsertHappyHour({
          id: row?.id,
          name: name.trim(),
          daysOfWeek,
          startTime,
          endTime,
          discountType,
          discountValue: Number(discountValue),
          isActive,
        }),
      onClose,
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Edit happy hour' : 'Add happy hour'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>
              Name <span className="text-destructive">*</span>
            </label>
            <input
              className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
              placeholder="e.g. Weekday Evening Special"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
            {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
          </div>

          <div>
            <label className={label}>
              Days <span className="text-destructive">*</span>
            </label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {DOW_SHORT.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  title={DOW_FULL[i]}
                  onClick={() => toggleDay(i)}
                  className={`flex size-9 items-center justify-center rounded-full border text-xs font-semibold transition ${
                    daysOfWeek.includes(i)
                      ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                      : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            {submitted && errors.days && <p className={errorText}>{errors.days}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>
                Start time <span className="text-destructive">*</span>
              </label>
              <input
                className={`${input} ${submitted && errors.time ? inputInvalid : ''}`}
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div>
              <label className={label}>
                End time <span className="text-destructive">*</span>
              </label>
              <input
                className={`${input} ${submitted && errors.time ? inputInvalid : ''}`}
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>
          {submitted && errors.time && <p className={errorText}>{errors.time}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Discount type</label>
              <select className={input} value={discountType} onChange={(e) => setDiscountType(e.target.value as DiscountType)}>
                <option value="percentage">Percentage</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div>
              <label className={label}>
                Discount value <span className="text-destructive">*</span>
              </label>
              <div className="relative">
                <input
                  className={`${input} pr-10 ${submitted && errors.discountValue ? inputInvalid : ''}`}
                  type="number"
                  min="0"
                  max={discountType === 'percentage' ? 100 : undefined}
                  step="0.01"
                  placeholder="0.00"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {discountType === 'percentage' ? '%' : currency}
                </span>
              </div>
              {submitted && errors.discountValue && <p className={errorText}>{errors.discountValue}</p>}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button className={`${btn} flex-1 border`} disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Happy Hour'}
          </button>
        </div>
      </div>
    </div>
  )
}
