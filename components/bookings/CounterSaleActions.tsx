'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Printer, Wrench } from 'lucide-react'
import { CounterCorrectionDialog } from '@/components/orders/CounterCorrectionDialog'

/** Reprint + Correct for one row of the Counter sales list. */
export function CounterSaleActions({
  orderId,
  invoiceId,
  status,
  currency,
  isManager,
}: {
  orderId: string
  invoiceId: string | null
  status: 'paid' | 'refunded' | 'void' | 'rebill' | 'cancelled'
  currency: string
  isManager: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // A cancelled order has nothing left to correct; every other state does.
  const canCorrect = status !== 'cancelled'
  return (
    <div className="flex items-center gap-2">
      {invoiceId && (
        <Link
          href={`/invoices/${invoiceId}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <Printer size={14} /> Reprint
        </Link>
      )}
      {canCorrect && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <Wrench size={14} /> {status === 'rebill' ? 'Re-bill' : 'Correct'}
        </button>
      )}
      {open && (
        <CounterCorrectionDialog
          orderId={orderId}
          currency={currency}
          isManager={isManager}
          onClose={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
