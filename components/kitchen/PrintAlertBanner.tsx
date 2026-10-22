import Link from 'next/link'
import { Printer, AlertTriangle } from 'lucide-react'
import type { PrintAlert } from '@/lib/printing/queue'

/**
 * Loud, unmissable notice that paper isn't coming out (M19 #4: a job that did
 * not print must never vanish silently). Renders nothing when all is well; the
 * web-print link on every ticket keeps working regardless.
 */
export function PrintAlertBanner({ alert }: { alert: PrintAlert | null }) {
  if (!alert) return null
  const bits: string[] = []
  if (alert.failed) bits.push(`${alert.failed} print job${alert.failed > 1 ? 's' : ''} failed`)
  if (alert.unconfirmed) bits.push(`${alert.unconfirmed} not confirmed by the printer`)
  if (alert.stuck) bits.push(`${alert.stuck} waiting too long`)
  if (alert.offlinePrinters.length) bits.push(`${alert.offlinePrinters.join(', ')} offline`)
  if (bits.length === 0) {
    return null
  }
  return (
    <div
      role="alert"
      className="mt-4 flex flex-wrap items-center gap-4 rounded-2xl border border-red-500/30 border-l-4 border-l-red-600 bg-red-500/5 px-4 py-3.5 text-sm shadow-sm"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-600/10">
        <AlertTriangle size={18} className="text-red-600" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-red-700 dark:text-red-400">Printing problem: {bits.join(' · ')}</p>
        <p className="mt-0.5 text-muted-foreground">
          Tickets may not have printed — use the browser print link on a ticket if needed.
        </p>
      </div>
      <Link
        href="/kitchen/printers"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-red-600 px-4 font-semibold text-white shadow-sm transition hover:bg-red-700"
      >
        <Printer size={15} /> Check printers
      </Link>
    </div>
  )
}
