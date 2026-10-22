'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveTypedOrderSettings } from '@/lib/actions/typed-orders'

const input = 'w-28 rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'

export function TypedOrderSettingsForm({
  initial,
}: {
  initial: { takeawayEnabled: boolean; deliveryEnabled: boolean; defaultDeliveryFee: number; deliveryFeeTaxRate: number }
}) {
  const router = useRouter()
  const [s, setS] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()
  const patch = (p: Partial<typeof s>) => {
    setS((c) => ({ ...c, ...p }))
    setSaved(false)
  }

  return (
    <div className="mt-6 space-y-6 rounded-xl border border-border bg-card p-5 shadow-sm">
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 size-4" checked={s.takeawayEnabled} onChange={(e) => patch({ takeawayEnabled: e.target.checked })} />
        <span>
          <span className="block text-sm font-medium">Take takeaway orders</span>
          <span className="block text-sm text-muted-foreground">Staff can place orders for pickup. They go to the kitchen with a Takeaway tag; no table is opened.</span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 size-4" checked={s.deliveryEnabled} onChange={(e) => patch({ deliveryEnabled: e.target.checked })} />
        <span>
          <span className="block text-sm font-medium">Take delivery orders</span>
          <span className="block text-sm text-muted-foreground">Needs an address and a phone number; tracked from the kitchen to the doorstep.</span>
        </span>
      </label>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className="text-sm font-medium">Default delivery fee</label>
          <input className={`${input} mt-1 block`} type="number" min={0} step="any" value={s.defaultDeliveryFee} onChange={(e) => patch({ defaultDeliveryFee: Number(e.target.value) })} />
          <p className="mt-1 text-sm text-muted-foreground">Pre-filled on each delivery; staff can change it per order (0 for free delivery).</p>
        </div>
        <div>
          <label className="text-sm font-medium">GST on the fee (%)</label>
          <input className={`${input} mt-1 block`} type="number" min={0} max={100} step="any" value={s.deliveryFeeTaxRate} onChange={(e) => patch({ deliveryFeeTaxRate: Number(e.target.value) })} />
          <p className="mt-1 text-sm text-muted-foreground">Added on top of the fee, as its own line on the bill.</p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Saved.</p>}
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await saveTypedOrderSettings(s)
            if (r.error) {
              setError(r.error)
              setSaved(false)
            } else {
              setError(null)
              setSaved(true)
              router.refresh()
            }
          })
        }
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  )
}
