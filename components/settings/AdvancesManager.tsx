'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2, X, HandCoins, Users, Wallet, Loader2 } from 'lucide-react'
import { recordAdvance, deleteAdvance } from '@/lib/actions/payroll'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { formatMoney } from '@/lib/format'

/**
 * Instalment suggestion rounds UP to the next cent, not to the nearest one —
 * rounding to nearest can under-shoot (e.g. 1000/3 -> 333.33, and
 * 3 * 333.33 = 999.99), silently leaving a leftover that pushes recovery
 * into an extra period beyond the months the owner chose.
 */
function suggestInstalment(amount: number, months: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(months) || months <= 0) return 0
  const scaledCents = Number(((amount * 100) / months).toPrecision(12))
  return Math.ceil(scaledCents) / 100
}

type AdvanceRow = {
  id: string
  membershipId: string
  fullName: string | null
  email: string | null
  amount: string
  instalmentAmount: string
  note: string | null
  givenAt: string
  recovered: number
  outstanding: number
}
type StaffOption = { id: string; fullName: string | null; email: string | null }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'
const modalInput =
  'w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20'

export function AdvancesManager({
  advances,
  staff,
  currency,
}: {
  advances: AdvanceRow[]
  staff: StaffOption[]
  currency: string
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const money = (n: number) => formatMoney(n, currency)

  const run: Run = (fn, onSuccess) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) {
        setError(r.error)
        toast.error(r.error)
      } else {
        router.refresh()
        onSuccess?.()
      }
    })
  }

  const stats = useMemo(() => {
    const staffWithAdvances = new Set(advances.map((a) => a.membershipId)).size
    const totalOutstanding = advances.reduce((sum, a) => sum + a.outstanding, 0)
    return { staffWithAdvances, totalOutstanding, count: advances.length }
  }, [advances])

  async function handleDelete(row: AdvanceRow) {
    await confirm({
      title: `Delete this advance for ${row.fullName || row.email}?`,
      description: `${money(Number(row.amount))} given on ${row.givenAt}. This cannot be undone.`,
      confirmText: 'Delete',
      onConfirm: async () => {
        const r = await deleteAdvance(row.id)
        if (r.error) {
          setError(r.error)
          toast.error(r.error)
        } else {
          router.refresh()
          toast.success(`Advance for ${row.fullName || row.email} deleted.`)
        }
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={Users} label="Employees with advances" value={stats.staffWithAdvances} accent="bg-primary/10 text-primary" />
        <StatCard icon={HandCoins} label="Advances on record" value={stats.count} accent="bg-muted text-muted-foreground" />
        <StatCard
          icon={Wallet}
          label="Total outstanding"
          value={money(stats.totalOutstanding)}
          accent="bg-amber-500/10 text-amber-600"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All advances</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setOpen(true)}
          disabled={staff.length === 0}
        >
          <Plus size={15} /> Record advance
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Instalment</th>
                <th className="px-4 py-3 text-right font-medium">Recovered</th>
                <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                <th className="px-4 py-3 font-medium">Given On</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {advances.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No advances recorded yet.
                  </td>
                </tr>
              )}
              {advances.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.fullName || row.email || 'Unnamed'}</div>
                    {row.note && <div className="text-sm text-muted-foreground">{row.note}</div>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(Number(row.amount))}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {money(Number(row.instalmentAmount))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600">{money(row.recovered)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {row.outstanding <= 0 ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                        Repaid
                      </span>
                    ) : (
                      money(row.outstanding)
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{row.givenAt}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        className={`${btn} text-destructive`}
                        disabled={pending}
                        onClick={() => handleDelete(row)}
                        aria-label="Delete"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <RecordAdvanceModal
          staff={staff}
          currency={currency}
          pending={pending}
          error={error}
          run={run}
          onClose={() => {
            setError(null)
            setOpen(false)
          }}
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
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function RecordAdvanceModal({
  staff,
  currency,
  pending,
  error,
  run,
  onClose,
}: {
  staff: StaffOption[]
  currency: string
  pending: boolean
  error: string | null
  run: Run
  onClose: () => void
}) {
  const [membershipId, setMembershipId] = useState(staff[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [months, setMonths] = useState('1')
  const [instalmentAmount, setInstalmentAmount] = useState('')
  const [instalmentTouched, setInstalmentTouched] = useState(false)
  const [note, setNote] = useState('')
  const [givenAt, setGivenAt] = useState(new Date().toISOString().slice(0, 10))
  const [submitted, setSubmitted] = useState(false)
  useBodyScrollLock()

  // Convenience only: "recover over N months" auto-fills the instalment, but
  // the owner can override it directly — the stored field is instalmentAmount,
  // not months (the payroll run reads a flat instalment, not a formula).
  const suggestedInstalment =
    amount !== '' && months !== '' && Number(months) > 0 ? suggestInstalment(Number(amount), Number(months)) : null

  function onAmountOrMonthsChange(nextAmount: string, nextMonths: string) {
    setAmount(nextAmount)
    setMonths(nextMonths)
    if (!instalmentTouched) {
      const n =
        nextAmount !== '' && nextMonths !== '' && Number(nextMonths) > 0
          ? suggestInstalment(Number(nextAmount), Number(nextMonths))
          : null
      setInstalmentAmount(n === null ? '' : String(n))
    }
  }

  const amountError =
    amount.trim() === '' ? 'Amount is required' : Number.isNaN(Number(amount)) || Number(amount) <= 0 ? 'Enter a valid amount' : null
  const instalmentError =
    instalmentAmount.trim() === ''
      ? 'Instalment is required'
      : Number.isNaN(Number(instalmentAmount)) || Number(instalmentAmount) <= 0
        ? 'Enter a valid amount'
        : amount !== '' && Number(instalmentAmount) > Number(amount)
          ? 'Cannot exceed the advance amount'
          : null
  const dateError = givenAt === '' ? 'Date is required' : null
  const canSubmit = !!membershipId && !amountError && !instalmentError && !dateError

  function submit() {
    setSubmitted(true)
    if (!canSubmit) return
    run(
      () =>
        recordAdvance({
          membershipId,
          amount: Number(amount),
          instalmentAmount: Number(instalmentAmount),
          note: note.trim() || undefined,
          givenAt,
        }),
      () => {
        const name = staff.find((s) => s.id === membershipId)?.fullName || 'the employee'
        toast.success(`Advance of ${formatMoney(Number(amount), currency)} recorded for ${name}.`)
        onClose()
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
              <HandCoins size={19} />
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Record advance</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Give an advance and schedule its recovery.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-6 py-5">
          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
              {error}
            </p>
          )}

          <div>
            <label className="text-sm font-medium text-muted-foreground">Employee</label>
            <select
              className={`${modalInput} mt-1`}
              value={membershipId}
              onChange={(e) => setMembershipId(e.target.value)}
            >
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName || s.email}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-muted-foreground">Amount</label>
              <input
                className={`${modalInput} mt-1 ${submitted && amountError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => onAmountOrMonthsChange(e.target.value, months)}
                autoFocus
              />
              {submitted && amountError && <p className="mt-1 text-xs text-destructive">{amountError}</p>}
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Given on</label>
              <input
                className={`${modalInput} mt-1 ${submitted && dateError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                type="date"
                value={givenAt}
                onChange={(e) => setGivenAt(e.target.value)}
              />
              {submitted && dateError && <p className="mt-1 text-xs text-destructive">{dateError}</p>}
            </div>
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
            <label className="mb-2 block text-sm font-semibold text-amber-700 dark:text-amber-400">
              Recovery schedule
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Recover over (months)</label>
                <input
                  className={`${modalInput} mt-1 bg-card`}
                  type="number"
                  min="1"
                  step="1"
                  value={months}
                  onChange={(e) => onAmountOrMonthsChange(amount, e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Instalment per period</label>
                <input
                  className={`${modalInput} mt-1 bg-card ${submitted && instalmentError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={instalmentAmount}
                  onChange={(e) => {
                    setInstalmentTouched(true)
                    setInstalmentAmount(e.target.value)
                  }}
                />
              </div>
            </div>
            {submitted && instalmentError ? (
              <p className="mt-1.5 text-xs text-destructive">{instalmentError}</p>
            ) : (
              suggestedInstalment !== null && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Suggested: {formatMoney(suggestedInstalment, currency)} per period. The last instalment is
                  automatically whatever remains once mostly repaid.
                </p>
              )
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-muted-foreground">Note (optional)</label>
            <input
              className={`${modalInput} mt-1`}
              placeholder="e.g. Medical emergency"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <button
            className="rounded-lg border border-border px-4 py-2.5 text-sm font-semibold transition hover:bg-muted"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending || !membershipId}
            onClick={submit}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Record advance
          </button>
        </div>
      </div>
    </div>
  )
}
