'use client'

import { useState, useTransition } from 'react'
import { Download } from 'lucide-react'
import { exportRevenueReportCsv } from '@/lib/actions/reports'

/**
 * Downloads a report as CSV (AROS-65).
 *
 * The file is BUILT ON THE SERVER by a Server Action that re-checks the session,
 * the manager role and the tenant — the browser only receives text it was
 * already allowed to see, and there is no public export URL to leak. This
 * component just turns that text into a saved file, which needs the DOM and is
 * therefore the one client-side piece.
 */
export function ExportCsvButton({
  from,
  to,
  dataset = 'daily',
  label = 'Download CSV',
}: {
  from: string
  to: string
  dataset?: 'daily' | 'resources' | 'food' | 'memberships'
  label?: string
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function download() {
    setError(null)
    start(async () => {
      const r = await exportRevenueReportCsv({ start: from, end: to, dataset })
      if (r.error || !r.csv) {
        setError(r.error ?? 'Could not build the export.')
        return
      }
      // text/csv + BOM-free content; the filename comes from the server so the
      // period in it always matches the data inside.
      const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = r.filename ?? 'report.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoked on the next tick: Safari needs the object URL to outlive the
      // click handler, so revoking synchronously can abort the download.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={download}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-1.5 text-sm font-semibold shadow-sm transition-colors hover:bg-muted disabled:opacity-60"
      >
        <Download size={15} />
        {pending ? 'Preparing…' : label}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
