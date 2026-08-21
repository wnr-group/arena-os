'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { AlertTriangle, HelpCircle, Loader2 } from 'lucide-react'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'

type ConfirmOptions = {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** `destructive` (red, default) for deletions; `default` for neutral confirmations. */
  variant?: 'destructive' | 'default'
  /**
   * When provided, clicking confirm runs this instead of closing right away —
   * the dialog stays open with a spinner on the confirm button until it
   * settles, then closes. Handle your own success/error feedback (toast,
   * etc.) inside; the dialog closes either way once it resolves.
   */
  onConfirm?: () => Promise<void>
}

type ConfirmState = ConfirmOptions & { resolve: (result: boolean) => void }

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

/**
 * App-wide replacement for `window.confirm`. Mount once near the root
 * (see app/layout.tsx) and call `useConfirm()` anywhere below it to await a
 * styled confirm/cancel dialog instead of the browser's native prompt.
 */
export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...options, resolve })
    })
  }, [])

  function settle(result: boolean) {
    state?.resolve(result)
    setState(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && <ConfirmDialogView state={state} onCancel={() => settle(false)} onConfirm={() => settle(true)} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialogView({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState
  onCancel: () => void
  onConfirm: () => void
}) {
  const [pending, setPending] = useState(false)
  useBodyScrollLock()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleConfirmClick() {
    if (!state.onConfirm) {
      onConfirm()
      return
    }
    setPending(true)
    try {
      await state.onConfirm()
    } finally {
      setPending(false)
    }
    onConfirm()
  }

  const destructive = state.variant !== 'default'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={pending ? undefined : onCancel}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
              destructive ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
            }`}
          >
            {destructive ? <AlertTriangle size={18} /> : <HelpCircle size={18} />}
          </div>
          <div className="min-w-0 pt-1">
            <h2 id="confirm-dialog-title" className="text-base font-semibold">
              {state.title}
            </h2>
            {state.description && (
              <p className="mt-1 text-sm text-muted-foreground">{state.description}</p>
            )}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onCancel}
            autoFocus
          >
            {state.cancelText ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
              destructive
                ? 'bg-destructive text-white hover:opacity-90'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            }`}
            disabled={pending}
            onClick={handleConfirmClick}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {state.confirmText ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Await this instead of `window.confirm(...)` to show the app's styled confirm dialog. */
export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmDialogProvider')
  return ctx
}
