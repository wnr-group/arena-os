'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus,
  Pencil,
  Ban,
  RotateCcw,
  X,
  BadgeCheck,
  CheckCircle2,
  XCircle,
  Wallet,
} from 'lucide-react'
import {
  createMembershipPlan,
  updateMembershipPlan,
  setMembershipPlanActive,
} from '@/lib/actions/membership-plans'
import { formatMoney } from '@/lib/format'

export type MembershipPlanRow = {
  id: string
  name: string
  /** numeric(10,2) — a string all the way from Postgres, never a float. */
  price: string
  durationMonths: number
  discountPercent: string
  freeHours: string
  walletCredit: string
  isActive: boolean
}
type Modal = { mode: 'add' } | { mode: 'edit'; row: MembershipPlanRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

/** `1` → `1 month`, `12` → `12 months`. */
export function durationLabel(months: number): string {
  return `${months} month${months === 1 ? '' : 's'}`
}

/** Drop a trailing `.00` so `2.00` free hours reads as `2`. */
const trimZeros = (v: string) => String(Number(v))

export function MembershipPlansManager({
  plans,
  currency,
}: {
  plans: MembershipPlanRow[]
  currency: string
}) {
  const router = useRouter()
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
    const total = plans.length
    const active = plans.filter((p) => p.isActive).length
    const credit = plans
      .filter((p) => p.isActive)
      .reduce((sum, p) => sum + Number(p.walletCredit), 0)
    return { total, active, inactive: total - active, credit }
  }, [plans])

  const money = (v: string | number) => formatMoney(v, currency)

  function toggleActive(row: MembershipPlanRow) {
    if (row.isActive) {
      if (
        !window.confirm(
          `Are you sure you want to deactivate ${row.name}? Customers will no longer be able to purchase this plan. It stays on record, so memberships already sold are unaffected.`,
        )
      )
        return
    }
    run(() => setMembershipPlanActive(row.id, !row.isActive))
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={BadgeCheck} label="Total plans" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="On sale" value={stats.active} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={XCircle} label="Retired" value={stats.inactive} accent="bg-muted text-muted-foreground" />
        <StatCard icon={Wallet} label="Credit on offer" value={money(stats.credit)} accent="bg-primary/10 text-primary" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All membership plans</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={15} /> Add plan
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Discount</th>
                <th className="px-4 py-3 font-medium">Free hours</th>
                <th className="px-4 py-3 font-medium">Wallet credit</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {plans.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">No membership plans yet.</p>
                    <p className="mt-1">Create your first plan so customers can subscribe.</p>
                    <button
                      className={`${btn} mt-4 inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
                      onClick={() => setModal({ mode: 'add' })}
                    >
                      <Plus size={15} /> Create plan
                    </button>
                  </td>
                </tr>
              )}
              {plans.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="px-4 py-3 tabular-nums">{money(p.price)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{durationLabel(p.durationMonths)}</td>
                  <td className="px-4 py-3 tabular-nums">{trimZeros(p.discountPercent)}%</td>
                  <td className="px-4 py-3 tabular-nums">{trimZeros(p.freeHours)}</td>
                  <td className="px-4 py-3 tabular-nums">{money(p.walletCredit)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        p.isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {p.isActive ? 'Active' : 'Inactive'}
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
                        title={p.isActive ? 'Deactivate' : 'Activate'}
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
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <PlanDialog
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

function PlanDialog({
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

  // Every field is seeded from the row being edited, so saving cannot blank a
  // value the manager did not touch.
  const [name, setName] = useState(editing?.name ?? '')
  const [price, setPrice] = useState(editing ? trimZeros(editing.price) : '')
  const [durationMonths, setDurationMonths] = useState(editing ? String(editing.durationMonths) : '1')
  const [discountPercent, setDiscountPercent] = useState(editing ? trimZeros(editing.discountPercent) : '0')
  const [freeHours, setFreeHours] = useState(editing ? trimZeros(editing.freeHours) : '0')
  const [walletCredit, setWalletCredit] = useState(editing ? trimZeros(editing.walletCredit) : '0')
  const [isActive, setIsActive] = useState(editing?.isActive ?? true)

  const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
  const priceN = num(price)
  const durationN = num(durationMonths)
  const discountN = num(discountPercent)
  const freeHoursN = num(freeHours)
  const walletN = num(walletCredit)

  const nameError = !name.trim() ? 'A plan name is required.' : null
  const priceError = !Number.isFinite(priceN) || priceN < 0 ? 'Enter a price of zero or more.' : null
  const durationError =
    !Number.isInteger(durationN) || durationN < 1 ? 'Enter a whole number of months, at least 1.' : null
  const discountError =
    !Number.isFinite(discountN) || discountN < 0 || discountN > 100
      ? 'Enter a discount between 0 and 100.'
      : null
  const freeHoursError =
    !Number.isFinite(freeHoursN) || freeHoursN < 0 ? 'Free hours cannot be negative.' : null
  const walletError =
    !Number.isFinite(walletN) || walletN < 0 ? 'Wallet credit cannot be negative.' : null
  const invalid = Boolean(
    nameError || priceError || durationError || discountError || freeHoursError || walletError,
  )

  function submit() {
    if (invalid || pending) return
    const values = {
      name,
      price: priceN,
      durationMonths: durationN,
      discountPercent: discountN,
      freeHours: freeHoursN,
      walletCredit: walletN,
      isActive,
    }
    run(
      () => (editing ? updateMembershipPlan(editing.id, values) : createMembershipPlan(values)),
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
          <h2 className="font-semibold">{editing ? `Edit ${editing.name}` : 'Add membership plan'}</h2>
          <button
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <Field label="Plan name" error={nameError}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="Gold"
            className={input}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={`Price (${currency})`} error={priceError}>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={pending}
              placeholder="2000"
              className={input}
            />
          </Field>
          <Field label="Duration (months)" error={durationError}>
            <input
              type="number"
              min={1}
              step="1"
              value={durationMonths}
              onChange={(e) => setDurationMonths(e.target.value)}
              disabled={pending}
              className={input}
            />
          </Field>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Benefits</p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="Discount %" error={discountError}>
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                inputMode="decimal"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
                disabled={pending}
                className={input}
              />
            </Field>
            <Field label="Free hours" error={freeHoursError}>
              <input
                type="number"
                min={0}
                step="0.5"
                inputMode="decimal"
                value={freeHours}
                onChange={(e) => setFreeHours(e.target.value)}
                disabled={pending}
                className={input}
              />
            </Field>
            <Field label={`Wallet (${currency})`} error={walletError}>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={walletCredit}
                onChange={(e) => setWalletCredit(e.target.value)}
                disabled={pending}
                className={input}
              />
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Stored as separate values so billing can apply them automatically.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            disabled={pending}
          />
          Active — customers can purchase this plan
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={pending} className={`${btn} border`}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pending || invalid}
            className={`${btn} bg-primary text-primary-foreground`}
          >
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Create plan'}
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
    <div className="rounded-xl border border-border p-4">
      <div className={`inline-flex size-8 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={16} />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
