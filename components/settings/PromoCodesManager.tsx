'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Ban, RotateCcw, X, TicketPercent, CheckCircle2, XCircle, Infinity as InfinityIcon } from 'lucide-react'
import { upsertPromoCode, setPromoCodeActive } from '@/lib/actions/promo-codes'
import { formatMoney } from '@/lib/format'
import { useConfirm } from '@/components/ui/ConfirmDialog'

export type PromoRow = {
  id: string
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: string
  validFrom: string
  validUntil: string
  maxUses: number | null
  uses: number
  isActive: boolean
}
type Modal = { mode: 'add' } | { mode: 'edit'; row: PromoRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

/**
 * Display status, derived from the row — the database keeps only `is_active`,
 * the dates and the counters, and this ticket does not add a status column.
 * Priority: switched off beats everything, then the usage limit, then the
 * window.
 */
type Status = 'Inactive' | 'Usage Limit Reached' | 'Scheduled' | 'Expired' | 'Active'

export function statusOf(p: PromoRow, now = new Date()): Status {
  if (!p.isActive) return 'Inactive'
  if (p.maxUses !== null && p.uses >= p.maxUses) return 'Usage Limit Reached'
  if (now < new Date(p.validFrom)) return 'Scheduled'
  if (now > new Date(p.validUntil)) return 'Expired'
  return 'Active'
}

const STATUS_STYLE: Record<Status, string> = {
  Active: 'bg-emerald-500/10 text-emerald-600',
  Scheduled: 'bg-blue-500/10 text-blue-600',
  Expired: 'bg-amber-500/10 text-amber-600',
  'Usage Limit Reached': 'bg-amber-500/10 text-amber-600',
  Inactive: 'bg-muted text-muted-foreground',
}

/** `2026-08-10T12:30:00Z` → `2026-08-10T18:00` for a datetime-local input. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function PromoCodesManager({ promos, currency }: { promos: PromoRow[]; currency: string }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)

  const run: Run = (fn, onSuccess) => {
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

  const stats = useMemo(() => {
    const total = promos.length
    const active = promos.filter((p) => statusOf(p) === 'Active').length
    const redemptions = promos.reduce((sum, p) => sum + p.uses, 0)
    return { total, active, inactive: total - active, redemptions }
  }, [promos])

  const money = (v: string) => formatMoney(v, currency)
  const discountOf = (p: PromoRow) =>
    p.discountType === 'percentage' ? `${Number(p.discountValue)}%` : money(p.discountValue)

  async function toggleActive(row: PromoRow) {
    if (row.isActive) {
      await confirm({
        title: `Expire ${row.code}?`,
        description:
          'Customers will no longer be able to use this code. It stays on record, so invoices that already used it are unaffected.',
        confirmText: 'Expire code',
        onConfirm: async () => {
          const r = await setPromoCodeActive(row.id, false)
          if (r.error) setError(r.error)
          else router.refresh()
        },
      })
      return
    }
    run(() => setPromoCodeActive(row.id, true))
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={TicketPercent} label="Total codes" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="Active now" value={stats.active} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={XCircle} label="Not usable" value={stats.inactive} accent="bg-muted text-muted-foreground" />
        <StatCard icon={RotateCcw} label="Redemptions" value={stats.redemptions} accent="bg-primary/10 text-primary" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All promo codes</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={15} /> Add promo code
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Discount</th>
                <th className="px-4 py-3 font-medium">Validity</th>
                <th className="px-4 py-3 font-medium">Usage</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {promos.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">No promo codes yet.</p>
                    <p className="mt-1">
                      Create your first promo code to offer discounts during billing.
                    </p>
                    <button
                      className={`${btn} mt-4 inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
                      onClick={() => setModal({ mode: 'add' })}
                    >
                      <Plus size={15} /> Create promo code
                    </button>
                  </td>
                </tr>
              )}
              {promos.map((p) => {
                const status = statusOf(p)
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-3 font-mono font-medium">{p.code}</td>
                    <td className="px-4 py-3 tabular-nums">{discountOf(p)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {shortDate(p.validFrom)} – {shortDate(p.validUntil)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {p.uses} / {p.maxUses ?? 'Unlimited'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[status]}`}>
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          title="Edit"
                          disabled={pending}
                          onClick={() => setModal({ mode: 'edit', row: p })}
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          title={p.isActive ? 'Expire' : 'Re-activate'}
                          disabled={pending}
                          onClick={() => toggleActive(p)}
                          className={`rounded-md p-2 transition disabled:opacity-50 ${
                            p.isActive
                              ? 'text-destructive hover:bg-destructive/10'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          {p.isActive ? <Ban size={15} /> : <RotateCcw size={15} />}
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
        <PromoDialog
          modal={modal}
          currency={currency}
          pending={pending}
          run={run}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

function PromoDialog({
  modal,
  currency,
  pending,
  run,
  onClose,
}: {
  modal: Modal
  currency: string
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const editing = modal.mode === 'edit' ? modal.row : null
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString()

  const [code, setCode] = useState(editing?.code ?? '')
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>(editing?.discountType ?? 'percentage')
  const [discountValue, setDiscountValue] = useState(editing ? String(Number(editing.discountValue)) : '10')
  const [validFrom, setValidFrom] = useState(toLocalInput(editing?.validFrom ?? new Date().toISOString()))
  const [validUntil, setValidUntil] = useState(toLocalInput(editing?.validUntil ?? inTwoWeeks))
  const [maxUses, setMaxUses] = useState(editing?.maxUses != null ? String(editing.maxUses) : '')
  const [isActive, setIsActive] = useState(editing?.isActive ?? true)

  const value = Number(discountValue)
  const limit = maxUses.trim() === '' ? null : Number(maxUses)

  const codeError = editing
    ? null
    : !code.trim()
      ? 'A promo code is required.'
      : !/^[A-Za-z0-9._-]+$/.test(code.trim())
        ? 'Use letters, numbers, dot, dash or underscore only.'
        : null
  const valueError =
    !Number.isFinite(value) || value < 0
      ? 'Enter a discount of zero or more.'
      : discountType === 'percentage' && value > 100
        ? 'A percentage discount cannot exceed 100.'
        : null
  const dateError =
    !validFrom || !validUntil
      ? 'Both dates are required.'
      : new Date(validUntil) <= new Date(validFrom)
        ? 'The end date must be after the start date.'
        : null
  const limitError =
    limit !== null && (!Number.isInteger(limit) || limit < 1)
      ? 'A usage limit must be a whole number of at least 1.'
      : null
  const invalid = Boolean(codeError || valueError || dateError || limitError)

  function submit() {
    if (invalid || pending) return
    run(
      () =>
        upsertPromoCode({
          id: editing?.id,
          code: editing?.code ?? code,
          discountType,
          discountValue: value,
          validFrom: new Date(validFrom),
          validUntil: new Date(validUntil),
          maxUses: limit,
          isActive,
        }),
      onClose,
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{editing ? `Edit ${editing.code}` : 'Add promo code'}</h2>
          <button onClick={onClose} disabled={pending} aria-label="Close" className="text-muted-foreground hover:text-foreground disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <Field label="Promo code" error={codeError}>
          <input
            value={editing?.code ?? code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={pending || Boolean(editing)}
            placeholder="WELCOME10"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={`${input} font-mono disabled:opacity-60`}
          />
          {editing && (
            <p className="mt-1 text-xs text-muted-foreground">
              The code cannot be changed — invoices already reference it.
            </p>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Discount type">
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as 'percentage' | 'fixed')}
              disabled={pending}
              className={input}
            >
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed amount</option>
            </select>
          </Field>
          <Field label={discountType === 'percentage' ? 'Percent off' : `Amount off (${currency})`} error={valueError}>
            <input
              type="number"
              min={0}
              max={discountType === 'percentage' ? 100 : undefined}
              step="0.01"
              inputMode="decimal"
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              disabled={pending}
              className={input}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid from">
            <input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} disabled={pending} className={input} />
          </Field>
          <Field label="Valid until" error={dateError}>
            <input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={pending} className={input} />
          </Field>
        </div>

        <Field label="Maximum uses" error={limitError}>
          <input
            type="number"
            min={1}
            step="1"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            disabled={pending}
            placeholder="Leave blank for unlimited"
            className={input}
          />
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <InfinityIcon size={12} /> Blank means unlimited.
            {editing && ` Used ${editing.uses} time${editing.uses === 1 ? '' : 's'} so far — editing never resets that.`}
          </p>
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={pending} />
          Active — cashiers can apply this code
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={pending} className={`${btn} border`}>
            Cancel
          </button>
          <button onClick={submit} disabled={pending || invalid} className={`${btn} bg-primary text-primary-foreground`}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Create promo code'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <div className="mt-1">{children}</div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
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
    <div className="group rounded-xl border border-border p-4 transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5">
      <div className={`inline-flex size-8 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110 ${accent}`}>
        <Icon size={16} />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
