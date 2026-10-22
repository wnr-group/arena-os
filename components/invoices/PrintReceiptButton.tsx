'use client'

import { useState, useTransition } from 'react'
import { Loader2, ReceiptText } from 'lucide-react'
import { toast } from 'sonner'
import { printReceipt } from '@/lib/actions/printing'

/**
 * Sends this bill/receipt to the venue's receipt printer (M19 #4). When no
 * printer is configured it says so — the neighbouring "Print / Save as PDF"
 * button (browser print) is always the fallback and is never replaced.
 */
export function PrintReceiptButton({ invoiceId }: { invoiceId: string }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null)
            const r = await printReceipt(invoiceId)
            if (r.error) setError(r.error)
            else toast.success('Sent to the receipt printer.')
          })
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
      >
        {pending ? <Loader2 size={16} className="animate-spin" /> : <ReceiptText size={16} />} Print on receipt printer
      </button>
      {error && (
        <span role="alert" className="mt-1 max-w-xs text-right text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  )
}
