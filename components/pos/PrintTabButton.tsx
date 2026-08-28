'use client'

import { Printer } from 'lucide-react'

/**
 * Opens the browser's print dialog for the running tab — same convention as
 * components/invoices/PrintButton.tsx and components/kitchen/KotPrintButton.tsx,
 * a distinct button because the running tab is a different document (an
 * estimate, not the GST invoice those print).
 */
export function PrintTabButton() {
  return (
    <button
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      <Printer size={16} /> Print check
    </button>
  )
}
