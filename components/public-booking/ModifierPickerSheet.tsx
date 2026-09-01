'use client'

import { useEffect, useState } from 'react'
import { X, Check } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { OrderableMenuItem } from './OrderMenuClient'
import type { CartModifier } from './OrderCartProvider'

/**
 * The customer-facing counterpart to the waiter screen's modifier picker
 * (components/orders/TakeOrderDialog.tsx) — same min/max enforcement logic,
 * styled to match the public ordering surface (bottom sheet, not a centered
 * modal). Client-side validation is a UX nicety only: createOrderCore
 * re-validates every group's min/max server-side when the order is placed.
 */
export function ModifierPickerSheet({
  item,
  currency,
  onClose,
  onConfirm,
}: {
  item: OrderableMenuItem
  currency: string
  onClose: () => void
  onConfirm: (modifiers: CartModifier[]) => void
}) {
  const groups = item.modifierGroups
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  function toggleOption(group: OrderableMenuItem['modifierGroups'][number], optionId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? []
      if (current.includes(optionId)) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) }
      }
      if (group.maxSelect === 1) return { ...prev, [group.id]: [optionId] }
      if (current.length >= group.maxSelect) return prev
      return { ...prev, [group.id]: [...current, optionId] }
    })
  }

  const isValid = groups.every((g) => (selected[g.id]?.length ?? 0) >= g.minSelect)

  function confirm() {
    setSubmitted(true)
    if (!isValid) return
    const modifiers: CartModifier[] = groups.flatMap((g) =>
      (selected[g.id] ?? []).map((optionId) => {
        const opt = g.options.find((o) => o.id === optionId)!
        return { groupName: g.name, optionId, optionName: opt.name, priceDelta: Number(opt.priceDelta) }
      }),
    )
    onConfirm(modifiers)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-3xl border border-border/60 bg-card shadow-2xl sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/60 p-4">
          <h2 className="text-base font-black tracking-tight">{item.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {groups.map((group) => (
            <div key={group.id}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold">{group.name}</p>
                <span className="text-xs font-medium text-muted-foreground">
                  {group.minSelect === group.maxSelect
                    ? `Choose ${group.minSelect}`
                    : group.minSelect === 0
                      ? `Up to ${group.maxSelect}`
                      : `Choose ${group.minSelect}–${group.maxSelect}`}
                </span>
              </div>
              <div className="mt-2 space-y-1.5">
                {group.options.map((opt) => {
                  const active = (selected[group.id] ?? []).includes(opt.id)
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => toggleOption(group, opt.id)}
                      aria-pressed={active}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition ${
                        active ? 'border-primary bg-primary/10 text-primary' : 'border-border/60 hover:border-primary/30'
                      }`}
                    >
                      <span className="flex items-center gap-2 font-semibold">
                        <span
                          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                            active ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          }`}
                        >
                          {active && <Check size={11} />}
                        </span>
                        {opt.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {Number(opt.priceDelta) === 0 ? 'No charge' : `+${formatMoney(opt.priceDelta, currency)}`}
                      </span>
                    </button>
                  )
                })}
              </div>
              {submitted && (selected[group.id]?.length ?? 0) < group.minSelect && (
                <p className="mt-1.5 text-xs font-medium text-destructive">
                  Choose {group.minSelect === group.maxSelect ? '' : 'at least '}
                  {group.minSelect} option{group.minSelect === 1 ? '' : 's'}.
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-2 border-t border-border/60 p-4">
          <button
            type="button"
            className="flex-1 rounded-xl border border-border px-4 py-3 text-sm font-bold transition hover:bg-muted"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition hover:bg-primary-hover active:scale-95"
            onClick={confirm}
          >
            Add to cart
          </button>
        </div>
      </div>
    </div>
  )
}
