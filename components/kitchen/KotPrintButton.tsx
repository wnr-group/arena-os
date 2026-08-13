'use client'

import { Printer } from 'lucide-react'

/**
 * Opens the browser's print dialog for a kitchen ticket — same pattern as
 * components/invoices/PrintButton.tsx. The print stylesheet in globals.css
 * (the .kot-print-sheet rules) is what makes the output a clean, large-text
 * slip instead of a screenshot of the app.
 */
export function KotPrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      <Printer size={16} /> Print / Save as PDF
    </button>
  )
}
