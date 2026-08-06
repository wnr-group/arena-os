'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, X, Clock, CheckCircle2, XCircle, Percent, Loader2 } from 'lucide-react'
import { upsertHappyHour, deleteHappyHour } from '@/lib/actions/happy-hours'
import { formatMoney } from '@/lib/format'

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
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

function formatTime(t: string) {
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function formatDiscount(type: DiscountType, value: string, currency: string) {
  return type === 'percentage' ? `${Number(value)}% off` : `${formatMoney(value, currency)} off`
}

export function HappyHoursManager({ currency, happyHours }: { currency: string; happyHours: HappyHourRow[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const run: Run = (fn, onSuccess, onSettled) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        router.refresh()
        onSuccess?.()
      }
      onSettled?.()
    })
  }

  const stats = useMemo(() => {
    const total = happyHours.length
    const active = happyHours.filter((h) => h.isActive).length
    const percentage = happyHours.filter((h) => h.discountType === 'percentage').length
    return { total, active, inactive: total - active, percentage }
  }, [happyHours])

  function handleDelete(row: HappyHourRow) {
    if (!window.confirm(`Delete happy hour "${row.name}"? This cannot be undone.`)) return
    setDeletingId(row.id)
    run(
      () => deleteHappyHour(row.id),
      undefined,
      () => setDeletingId(null),
    )
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Clock} label="Total rules" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="Active" value={stats.active} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} accent="bg-muted text-muted-foreground" />
        <StatCard icon={Percent} label="Percentage-based" value={stats.percentage} accent="bg-indigo-500/10 text-indigo-500" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">All happy hours</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={16} /> Add happy hour
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
              {happyHours.map((row) => (
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
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${
                        row.isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {row.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
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
              ))}
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
  accent,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string | number
  accent: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
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
            days.includes(i) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground/40'
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
    if (!name.trim()) e.name = 'Name is required.'
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
            <label className={label}>Name</label>
            <input
              className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
              placeholder="e.g. Weekday Evening Special"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
          </div>

          <div>
            <label className={label}>Days</label>
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
              <label className={label}>Start time</label>
              <input
                className={`${input} ${submitted && errors.time ? inputInvalid : ''}`}
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div>
              <label className={label}>End time</label>
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
              <label className={label}>Discount value</label>
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
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save changes' : 'Add happy hour'}
          </button>
          <button className={`${btn} border`} disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
