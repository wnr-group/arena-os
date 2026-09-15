'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, Users, Receipt, LayoutGrid, X } from 'lucide-react'
import { previewSplitBill, issueSplitBill } from '@/lib/actions/billing'
import type { CheckPricing } from '@/lib/billing/split'
import { formatMoney } from '@/lib/format'

export type SplitLineItem = {
  sourceId: string
  description: string
  qty: number
  unitPrice: number
  lineTotal: number
}

const btn = 'rounded-lg px-3.5 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

type Mode = 'even' | 'seat' | 'item'

export function SplitBillDialog({
  bookingId,
  items,
  currency,
  onClose,
  onSplit,
}: {
  bookingId: string
  /** Every billable food line, for the "by item" tap-to-assign picker. */
  items: SplitLineItem[]
  currency: string
  onClose: () => void
  onSplit: (checkCount: number) => void
}) {
  const [mode, setMode] = useState<Mode>('even')
  const [evenCount, setEvenCount] = useState(2)
  const [itemCheckCount, setItemCheckCount] = useState(2)
  // sourceId -> 0-based check index. Reset whenever the check count shrinks
  // below an already-assigned index, so a stale assignment can never point
  // at a check that no longer exists.
  const [assignments, setAssignments] = useState<Record<string, number>>({})
  const [preview, setPreview] = useState<CheckPricing[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, startPreview] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  function assign(sourceId: string, checkIndex: number) {
    setAssignments((prev) => ({ ...prev, [sourceId]: checkIndex }))
  }

  function changeItemCheckCount(next: number) {
    const clamped = Math.max(2, Math.min(20, next))
    setItemCheckCount(clamped)
    setAssignments((prev) => {
      const cleaned: Record<string, number> = {}
      for (const [id, idx] of Object.entries(prev)) {
        if (idx < clamped) cleaned[id] = idx
      }
      return cleaned
    })
  }

  const allAssigned = items.length > 0 && items.every((i) => assignments[i.sourceId] !== undefined)

  function runPreview() {
    setPreviewError(null)
    setPreview(null)
    const input =
      mode === 'even'
        ? { bookingId, mode: 'even' as const, checkCount: evenCount }
        : mode === 'seat'
          ? { bookingId, mode: 'seat' as const }
          : { bookingId, mode: 'item' as const, checkCount: itemCheckCount, assignments }
    startPreview(async () => {
      const r = await previewSplitBill(input)
      if (r.error || !r.checks) {
        setPreviewError(r.error ?? 'Could not preview the split.')
        return
      }
      setPreview(r.checks)
    })
  }

  // Re-preview whenever the mode or its inputs change — seat mode has no
  // inputs, so it previews immediately on selecting the tab.
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (mode === 'seat') runPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  function confirm() {
    if (pending) return
    setError(null)
    const input =
      mode === 'even'
        ? { bookingId, mode: 'even' as const, checkCount: evenCount }
        : mode === 'seat'
          ? { bookingId, mode: 'seat' as const }
          : { bookingId, mode: 'item' as const, checkCount: itemCheckCount, assignments }
    start(async () => {
      const r = await issueSplitBill(input)
      if (r.error || !r.checkCount) {
        setError(r.error ?? 'Could not split the bill.')
        return
      }
      onSplit(r.checkCount)
    })
  }

  const canConfirm =
    !pending && ((mode === 'even' && evenCount >= 2) || mode === 'seat' || (mode === 'item' && allAssigned))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-5">
          <h2 className="text-lg font-semibold">Split the bill</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-1.5 border-b border-border px-5 pt-3">
          <ModeTab active={mode === 'even'} onClick={() => setMode('even')} icon={<Receipt size={14} />}>
            Even
          </ModeTab>
          <ModeTab active={mode === 'seat'} onClick={() => setMode('seat')} icon={<Users size={14} />}>
            By seat
          </ModeTab>
          <ModeTab active={mode === 'item'} onClick={() => setMode('item')} icon={<LayoutGrid size={14} />}>
            By item
          </ModeTab>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {mode === 'even' && (
            <div>
              <p className="text-sm text-muted-foreground">Divide the whole bill evenly.</p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
                  onClick={() => setEvenCount((n) => Math.max(2, n - 1))}
                >
                  −
                </button>
                <span className="w-24 text-center text-base font-semibold">{evenCount} checks</span>
                <button
                  type="button"
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
                  onClick={() => setEvenCount((n) => Math.min(20, n + 1))}
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={previewing}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {previewing && <Loader2 size={14} className="animate-spin" />}
                  Preview
                </button>
              </div>
            </div>
          )}

          {mode === 'seat' && (
            <div>
              <p className="text-sm text-muted-foreground">
                One check per tagged seat. Items without a seat are shared evenly across every seat&apos;s check.
              </p>
              {previewing && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Checking tagged seats…
                </p>
              )}
            </div>
          )}

          {mode === 'item' && (
            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Tap each item to assign it to a check.</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    onClick={() => changeItemCheckCount(itemCheckCount - 1)}
                  >
                    −
                  </button>
                  <span className="text-sm font-medium">{itemCheckCount} checks</span>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    onClick={() => changeItemCheckCount(itemCheckCount + 1)}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {items.map((item) => (
                  <div key={item.sourceId} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">
                        {item.description}
                        <span className="ml-2 text-xs text-muted-foreground">×{item.qty}</span>
                      </p>
                      <span className="text-sm font-semibold tabular-nums">{formatMoney(item.lineTotal, currency)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Array.from({ length: itemCheckCount }, (_, i) => i).map((idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => assign(item.sourceId, idx)}
                          aria-pressed={assignments[item.sourceId] === idx}
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                            assignments[item.sourceId] === idx
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                          }`}
                        >
                          Check {idx + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                {!allAssigned && (
                  <p className="text-xs text-destructive">Assign every item to a check before previewing.</p>
                )}
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={previewing || !allAssigned}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {previewing && <Loader2 size={14} className="animate-spin" />}
                  Preview
                </button>
              </div>
            </div>
          )}

          {previewError && (
            <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {previewError}
            </p>
          )}

          {preview && preview.length > 0 && (
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {preview.map((c) => (
                  <div key={c.seq} className="rounded-lg border border-border p-3">
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(c.total, currency)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatMoney(c.subtotal, currency)} + {formatMoney(c.taxTotal, currency)} tax
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="mx-5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2 border-t border-border p-5">
          <button type="button" className={`${btn} flex-1 border border-border hover:bg-muted`} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={`${btn} flex flex-1 items-center justify-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            onClick={confirm}
            disabled={!canConfirm}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Splitting…' : 'Split bill'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}
