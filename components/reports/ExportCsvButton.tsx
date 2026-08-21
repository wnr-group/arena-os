'use client'

import { Download } from 'lucide-react'

export type CsvColumn<T> = { key: keyof T; label: string }

/** RFC 4180 field escaping — quote whenever the value contains a comma, quote, or newline. */
function csvField(value: unknown): string {
  const s = String(value ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Builds a CSV client-side from rows already on the page and triggers a
 * download — no server round trip, no CSV library, same "no PDF library"
 * spirit as components/invoices/PrintButton.tsx. The export is exactly what
 * RLS already scoped the page to show; nothing is re-fetched.
 */
export function ExportCsvButton<T extends Record<string, unknown>>({
  rows,
  columns,
  filename,
}: {
  rows: T[]
  columns: CsvColumn<T>[]
  filename: string
}) {
  function download() {
    const lines = [
      columns.map((c) => csvField(c.label)).join(','),
      ...rows.map((row) => columns.map((c) => csvField(row[c.key])).join(',')),
    ]
    // Leading BOM so Excel opens UTF-8 correctly instead of mangling it.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <button
      onClick={download}
      disabled={rows.length === 0}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Download size={15} /> Export CSV
    </button>
  )
}
