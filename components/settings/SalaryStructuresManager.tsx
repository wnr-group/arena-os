'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Wallet, Users, TrendingUp, TrendingDown, Loader2 } from 'lucide-react'
import { upsertSalaryStructure, deleteSalaryStructure } from '@/lib/actions/payroll'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { formatMoney } from '@/lib/format'

type Component = { label: string; amount: string }
type SalaryStructureRow = {
  id: string
  membershipId: string
  fullName: string | null
  email: string | null
  base: string
  allowances: Component[]
  deductions: Component[]
  effectiveFrom: string
}
type StaffOption = { id: string; fullName: string | null; email: string | null }
type Modal = { mode: 'add' } | { mode: 'edit'; row: SalaryStructureRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

function componentTotal(items: Component[]): number {
  return items.reduce((sum, c) => sum + Number(c.amount), 0)
}

function netPay(row: { base: string; allowances: Component[]; deductions: Component[] }): number {
  return Number(row.base) + componentTotal(row.allowances) - componentTotal(row.deductions)
}

export function SalaryStructuresManager({
  structures,
  staff,
  currency,
}: {
  structures: SalaryStructureRow[]
  staff: StaffOption[]
  currency: string
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
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
    const staffWithPay = new Set(structures.map((s) => s.membershipId)).size
    const currentTotal = structures.reduce((sum, s) => sum + netPay(s), 0)
    return { staffWithPay, currentTotal, versions: structures.length }
  }, [structures])

  async function handleDelete(row: SalaryStructureRow) {
    await confirm({
      title: `Delete this salary structure for ${row.fullName || row.email}?`,
      description: `Effective from ${row.effectiveFrom}. This cannot be undone.`,
      confirmText: 'Delete',
      onConfirm: async () => {
        const r = await deleteSalaryStructure(row.id)
        if (r.error) {
          setError(r.error)
          toast.error(r.error)
        } else {
          router.refresh()
          toast.success(`Salary structure for ${row.fullName || row.email} deleted.`)
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
        <StatCard icon={Users} label="Employees with pay set" value={stats.staffWithPay} accent="bg-primary/10 text-primary" />
        <StatCard icon={Wallet} label="Structure versions" value={stats.versions} accent="bg-muted text-muted-foreground" />
        <StatCard
          icon={TrendingUp}
          label="Combined net pay (all versions)"
          value={money(stats.currentTotal)}
          accent="bg-emerald-500/10 text-emerald-600"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All salary structures</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
          disabled={staff.length === 0}
        >
          <Plus size={15} /> Add salary structure
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 text-right font-medium">Base</th>
                <th className="px-4 py-3 text-right font-medium">Allowances</th>
                <th className="px-4 py-3 text-right font-medium">Deductions</th>
                <th className="px-4 py-3 text-right font-medium">Net Pay</th>
                <th className="px-4 py-3 font-medium">Effective From</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {structures.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No salary structures yet. Add one to get started.
                  </td>
                </tr>
              )}
              {structures.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{row.fullName || row.email || 'Unnamed'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(Number(row.base))}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600">
                    +{money(componentTotal(row.allowances))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-destructive">
                    -{money(componentTotal(row.deductions))}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(netPay(row))}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.effectiveFrom}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button className={btn} onClick={() => setModal({ mode: 'edit', row })} aria-label="Edit">
                        <Pencil size={15} />
                      </button>
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

      {modal && (
        <SalaryStructureModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          staff={staff}
          currency={currency}
          pending={pending}
          error={error}
          run={run}
          onClose={() => {
            setError(null)
            setModal(null)
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

const modalInput =
  'w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20'

function ComponentList({
  items,
  onChange,
  addLabel,
  accent,
  errors,
}: {
  items: Component[]
  onChange: (items: Component[]) => void
  addLabel: string
  accent: string
  /** Per-row messages (index-aligned); omit to render no validation state yet. */
  errors?: (string | null)[]
}) {
  function update(i: number, patch: Partial<Component>) {
    onChange(items.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i))
  }
  return (
    <div className="space-y-2">
      {items.map((c, i) => {
        const rowError = errors?.[i]
        return (
          <div key={i}>
            <div className="flex gap-2">
              <input
                className={`${modalInput} bg-card ${rowError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                placeholder="Label, e.g. HRA"
                value={c.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
              <input
                className={`${modalInput} w-32 bg-card ${rowError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={c.amount}
                onChange={(e) => update(i, { amount: e.target.value })}
              />
              <button
                type="button"
                className="flex shrink-0 items-center justify-center rounded-lg border border-transparent px-2.5 text-muted-foreground transition hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                onClick={() => remove(i)}
                aria-label="Remove"
              >
                <X size={16} />
              </button>
            </div>
            {rowError && <p className="mt-1 text-xs text-destructive">{rowError}</p>}
          </div>
        )
      })}
      <button
        type="button"
        className={`inline-flex items-center gap-1 text-sm font-semibold ${accent} hover:underline`}
        onClick={() => onChange([...items, { label: '', amount: '' }])}
      >
        <Plus size={14} /> {addLabel}
      </button>
    </div>
  )
}

/** null = valid; a blank row (no label, no amount) is left for the user to fill or abandon, not an error. */
function componentRowError(c: Component): string | null {
  const hasLabel = c.label.trim() !== ''
  const hasAmount = c.amount.trim() !== ''
  if (!hasLabel && !hasAmount) return null
  if (!hasLabel) return 'Enter a label'
  const n = Number(c.amount)
  if (!hasAmount || Number.isNaN(n) || n < 0) return 'Enter a valid amount'
  return null
}

function SalaryStructureModal({
  row,
  staff,
  currency,
  pending,
  error,
  run,
  onClose,
}: {
  row?: SalaryStructureRow
  staff: StaffOption[]
  currency: string
  pending: boolean
  error: string | null
  run: Run
  onClose: () => void
}) {
  const [membershipId, setMembershipId] = useState(row?.membershipId ?? staff[0]?.id ?? '')
  const [base, setBase] = useState(row?.base ?? '')
  const [allowances, setAllowances] = useState<Component[]>(row?.allowances ?? [])
  const [deductions, setDeductions] = useState<Component[]>(row?.deductions ?? [])
  const [effectiveFrom, setEffectiveFrom] = useState(row?.effectiveFrom ?? new Date().toISOString().slice(0, 10))
  const [submitted, setSubmitted] = useState(false)
  useBodyScrollLock()

  const net =
    (base === '' ? 0 : Number(base)) +
    allowances.reduce((s, a) => s + (Number(a.amount) || 0), 0) -
    deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0)

  const baseError =
    base.trim() === ''
      ? 'Base pay is required'
      : Number.isNaN(Number(base)) || Number(base) < 0
        ? 'Enter a valid amount'
        : null
  const dateError = effectiveFrom === '' ? 'Effective date is required' : null
  const allowanceErrors = allowances.map(componentRowError)
  const deductionErrors = deductions.map(componentRowError)
  const hasRowErrors = allowanceErrors.some(Boolean) || deductionErrors.some(Boolean)
  const canSubmit = !!membershipId && !baseError && !dateError && !hasRowErrors && net >= 0

  function submit() {
    setSubmitted(true)
    if (!canSubmit) return
    run(
      () =>
        upsertSalaryStructure({
          id: row?.id,
          membershipId,
          base: Number(base),
          allowances: allowances
            .filter((a) => a.label.trim())
            .map((a) => ({ label: a.label.trim(), amount: Number(a.amount) })),
          deductions: deductions
            .filter((d) => d.label.trim())
            .map((d) => ({ label: d.label.trim(), amount: Number(d.amount) })),
          effectiveFrom,
        }),
      () => {
        const name = staff.find((s) => s.id === membershipId)?.fullName || 'the employee'
        toast.success(row ? `Salary structure updated for ${name}.` : `Salary structure added for ${name}.`)
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
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Wallet size={19} />
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                {row ? 'Edit salary structure' : 'Add salary structure'}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Base pay, allowances and deductions.</p>
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
              <label className="text-sm font-medium text-muted-foreground">Base pay</label>
              <input
                className={`${modalInput} mt-1 ${submitted && baseError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                autoFocus
              />
              {submitted && baseError && <p className="mt-1 text-xs text-destructive">{baseError}</p>}
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Effective from</label>
              <input
                className={`${modalInput} mt-1 ${submitted && dateError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : ''}`}
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
              {submitted && dateError && <p className="mt-1 text-xs text-destructive">{dateError}</p>}
            </div>
          </div>

          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
            <label className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              <TrendingUp size={15} /> Allowances
            </label>
            <ComponentList
              items={allowances}
              onChange={setAllowances}
              addLabel="Add allowance"
              accent="text-emerald-700 dark:text-emerald-400"
              errors={submitted ? allowanceErrors : undefined}
            />
          </div>

          <div className="rounded-xl border border-destructive/20 bg-destructive/[0.04] p-4">
            <label className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-destructive">
              <TrendingDown size={15} /> Deductions
            </label>
            <ComponentList
              items={deductions}
              onChange={setDeductions}
              addLabel="Add deduction"
              accent="text-destructive"
              errors={submitted ? deductionErrors : undefined}
            />
          </div>

          <div>
            <div className="flex items-center justify-between rounded-xl bg-primary/5 px-4 py-3.5">
              <span className="text-sm font-semibold text-muted-foreground">Net pay</span>
              <span className={`text-xl font-bold tracking-tight ${net < 0 ? 'text-destructive' : 'text-primary'}`}>
                {formatMoney(net, currency)}
              </span>
            </div>
            {net < 0 && (
              <p className="mt-1.5 text-xs text-destructive">Deductions cannot exceed base pay plus allowances.</p>
            )}
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
            disabled={pending || !membershipId || net < 0}
            onClick={submit}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {row ? 'Save changes' : 'Add salary structure'}
          </button>
        </div>
      </div>
    </div>
  )
}
