'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Receipt, CheckCircle2, XCircle, Percent } from 'lucide-react'
import { upsertTaxRate, deleteTaxRate } from '@/lib/actions/tax-rates'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type TaxRateRow = { id: string; name: string; percent: string; isActive: boolean }
type Modal = { mode: 'add' } | { mode: 'edit'; row: TaxRateRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'
const NAME_PATTERN = /^[\p{L}\p{N} &'.,()-]+$/u

export function TaxRatesManager({ taxRates }: { taxRates: TaxRateRow[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)

  const run: Run = (fn, onSuccess) => {
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        router.refresh()
        onSuccess?.()
      }
    })
  }

  const stats = useMemo(() => {
    const total = taxRates.length
    const active = taxRates.filter((t) => t.isActive).length
    const avgPercent =
      total === 0 ? 0 : taxRates.reduce((sum, t) => sum + Number(t.percent), 0) / total
    return { total, active, inactive: total - active, avgPercent }
  }, [taxRates])

  async function handleDelete(row: TaxRateRow) {
    await confirm({
      title: `Delete tax rate "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        const r = await deleteTaxRate(row.id)
        if (r.error) toast.error(r.error)
        else router.refresh()
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Receipt} label="Total rates" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard
          icon={CheckCircle2}
          label="Active"
          value={stats.active}
          accent="bg-emerald-500/10 text-emerald-600"
        />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} accent="bg-muted text-muted-foreground" />
        <StatCard
          icon={Percent}
          label="Average rate"
          value={`${stats.avgPercent.toFixed(2)}%`}
          accent="bg-primary/10 text-primary"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All tax rates</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={15} /> Add Tax Rate
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Rate</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {taxRates.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No tax rates yet. Add one to get started.
                  </td>
                </tr>
              )}
              {taxRates.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{row.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.percent}%</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {row.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
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
        <TaxRateModal row={modal.mode === 'edit' ? modal.row : undefined} pending={pending} run={run} onClose={() => setModal(null)} />
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

function TaxRateModal({
  row,
  pending,
  run,
  onClose,
}: {
  row?: TaxRateRow
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [percent, setPercent] = useState(row?.percent ?? '')
  const [isActive, setIsActive] = useState(row?.isActive ?? true)
  const [submitted, setSubmitted] = useState(false)

  const errors = useMemo(() => {
    const e: { name?: string; percent?: string } = {}
    const trimmedName = name.trim()
    if (!trimmedName) e.name = 'Name is required.'
    else if (trimmedName.length < 2) e.name = 'Name must be at least 2 characters.'
    else if (trimmedName.length > 100) e.name = 'Name must be at most 100 characters.'
    else if (!NAME_PATTERN.test(trimmedName))
      e.name = "Name can only contain letters, numbers, spaces, and & - ' . , ( )"
    if (percent === '') e.percent = 'Percent is required.'
    else if (Number.isNaN(Number(percent))) e.percent = 'Enter a valid percent.'
    else if (Number(percent) < 0 || Number(percent) > 100) e.percent = 'Percent must be between 0 and 100.'
    return e
  }, [name, percent])
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () =>
        upsertTaxRate({
          id: row?.id,
          name: name.trim(),
          percent: Number(percent),
          isActive,
        }),
      onClose,
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Edit tax rate' : 'Add tax rate'}</h2>
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
              placeholder="e.g. GST 5%"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
            {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
          </div>
          <div>
            <label className={label}>
              Percent <span className="text-destructive">*</span>
            </label>
            <input
              className={`${input} ${submitted && errors.percent ? inputInvalid : ''}`}
              type="number"
              min="0"
              max="100"
              step="0.01"
              placeholder="0.00"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
            {submitted && errors.percent && <p className={errorText}>{errors.percent}</p>}
          </div>
          <label className="flex items-center gap-2 text-base">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button className={`${btn} flex-1 bg-primary text-primary-foreground`} disabled={pending} onClick={submit}>
            {row ? 'Save Changes' : 'Add Tax Rate'}
          </button>
        </div>
      </div>
    </div>
  )
}
