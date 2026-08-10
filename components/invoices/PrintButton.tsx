'use client'

import { Printer } from 'lucide-react'

/**
 * Opens the browser's print dialog, from which the user picks a printer or
 * "Save as PDF". No PDF library — the print stylesheet in globals.css is what
 * makes the output a clean invoice.
 */
export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      <Printer size={16} /> Print / Save as PDF
    </button>
  )
}
