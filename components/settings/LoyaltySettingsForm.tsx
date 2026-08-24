'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateLoyaltySettings } from '@/lib/actions/loyalty'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils/cn'

/**
 * Manager-only loyalty settings form.
 *
 * Same shape as BusinessProfileForm and WorkingHoursForm: local state,
 * useTransition, a single server action, then router.refresh(). Nothing here
 * decides authorisation — the action re-checks the manager role and the
 * database enforces it again through loyalty_settings_write.
 *
 * The fields are kept as STRINGS in state rather than numbers. A numeric input
 * bound to a number cannot hold the intermediate states a person types — an
 * empty box while they retype, or a trailing "." in "1." — and coercing on
 * every keystroke makes the field fight the user. The action coerces and
 * validates authoritatively.
 */

type Fields = {
  pointsPerUnit: string
  unitAmount: string
  pointValue: string
  minRedeemPoints: string
  isActive: boolean
}

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'

export function LoyaltySettingsForm({
  initial,
  currency,
}: {
  initial: {
    pointsPerUnit: number
    unitAmount: number
    pointValue: number
    minRedeemPoints: number
    isActive: boolean
  }
  currency: string
}) {
  const router = useRouter()
  const [fields, setFields] = useState<Fields>({
    pointsPerUnit: String(initial.pointsPerUnit),
    unitAmount: String(initial.unitAmount),
    pointValue: String(initial.pointValue),
    minRedeemPoints: String(initial.minRedeemPoints),
    isActive: initial.isActive,
  })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function set(patch: Partial<Fields>) {
    setFields((f) => ({ ...f, ...patch }))
    setSaved(false)
    setError(null)
  }

  // Mirrors the server's rules so the obvious mistake is caught before a round
  // trip. The action validates again regardless — this is convenience only.
  const positive = (raw: string) => {
    const n = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(n)) return 'Enter a number.'
    if (n <= 0) return 'Must be greater than zero — use the switch below to turn the programme off.'
    return null
  }
  const errors = {
    pointsPerUnit:
      positive(fields.pointsPerUnit) ??
      (Number.isInteger(Number(fields.pointsPerUnit)) ? null : 'Whole numbers only.'),
    unitAmount: positive(fields.unitAmount),
    pointValue: positive(fields.pointValue),
    minRedeemPoints: (() => {
      const n = Number(fields.minRedeemPoints)
      if (fields.minRedeemPoints.trim() === '' || !Number.isFinite(n)) return 'Enter a number.'
      if (n < 0) return 'Cannot be negative.'
      if (!Number.isInteger(n)) return 'Whole numbers only.'
      return null
    })(),
  }
  const hasError = Object.values(errors).some(Boolean)

  // A live worked example, so the four numbers stop being abstract.
  const preview = (() => {
    const per = Number(fields.pointsPerUnit)
    const unit = Number(fields.unitAmount)
    const value = Number(fields.pointValue)
    if (hasError) return null
    const exampleSpend = unit * 10
    const earned = Math.floor(exampleSpend / unit) * per
    return {
      spend: formatMoney(exampleSpend, currency),
      earned,
      worth: formatMoney(earned * value, currency),
    }
  })()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (hasError) return
    setError(null)
    start(async () => {
      const result = await updateLoyaltySettings({
        pointsPerUnit: fields.pointsPerUnit,
        unitAmount: fields.unitAmount,
        pointValue: fields.pointValue,
        minRedeemPoints: fields.minRedeemPoints,
        isActive: fields.isActive,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-6">
      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Earning</h2>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field
            id="pointsPerUnit"
            label="Points earned"
            hint="Points given for each whole unit of spend."
            value={fields.pointsPerUnit}
            onChange={(v) => set({ pointsPerUnit: v })}
            error={errors.pointsPerUnit}
            disabled={pending}
            inputMode="numeric"
          />
          <Field
            id="unitAmount"
            label="…for every"
            hint={`Spend, in ${currency}, that earns the points above.`}
            value={fields.unitAmount}
            onChange={(v) => set({ unitAmount: v })}
            error={errors.unitAmount}
            disabled={pending}
            inputMode="decimal"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Redeeming</h2>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field
            id="pointValue"
            label="One point is worth"
            hint={`Value in ${currency} when redeemed against a bill.`}
            value={fields.pointValue}
            onChange={(v) => set({ pointValue: v })}
            error={errors.pointValue}
            disabled={pending}
            inputMode="decimal"
          />
          <Field
            id="minRedeemPoints"
            label="Minimum points to redeem"
            hint="0 means no minimum."
            value={fields.minRedeemPoints}
            onChange={(v) => set({ minRedeemPoints: v })}
            error={errors.minRedeemPoints}
            disabled={pending}
            inputMode="numeric"
          />
        </div>
      </section>

      {preview && (
        <p className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          For example: a customer spending {preview.spend} earns{' '}
          <strong className="font-medium text-foreground">{preview.earned} points</strong>, worth{' '}
          <strong className="font-medium text-foreground">{preview.worth}</strong> off a future bill.
        </p>
      )}

      <section className="rounded-xl border border-border bg-card p-4">
        <label htmlFor="isActive" className="flex cursor-pointer items-start gap-3">
          <input
            id="isActive"
            name="isActive"
            type="checkbox"
            checked={fields.isActive}
            onChange={(e) => set({ isActive: e.target.checked })}
            disabled={pending}
            className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Loyalty programme is active</span>
            <span className="block text-xs text-muted-foreground">
              When off, no new points are earned and points cannot be redeemed at the till. Points
              already banked are kept and become spendable again if you switch it back on.
            </span>
          </span>
        </label>
      </section>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || hasError}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {saved && !pending && (
          <span className="text-sm text-muted-foreground" role="status">
            Saved.
          </span>
        )}
      </div>
    </form>
  )
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  disabled,
  inputMode,
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (next: string) => void
  error: string | null
  disabled: boolean
  inputMode: 'numeric' | 'decimal'
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-hint`}
        className={cn(input, error && 'border-destructive')}
      />
      <p id={`${id}-hint`} className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? hint}
      </p>
    </div>
  )
}
