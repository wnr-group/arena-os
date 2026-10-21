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
    <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-600/50 bg-red-600/10 px-4 py-3 text-sm">
      <AlertTriangle size={18} className="shrink-0 text-red-600" />
      <p className="min-w-0 flex-1 font-medium text-red-700">
        Printing problem: {bits.join(' · ')}. Tickets may not have printed — use the browser print link on a ticket if needed.
      </p>
      <Link href="/kitchen/printers" className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 font-semibold text-white">
        <Printer size={15} /> Check printers
      </Link>
    </div>
  )
}
