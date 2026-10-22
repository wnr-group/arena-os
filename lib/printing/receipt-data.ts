import type { InvoiceReceipt } from '@/lib/billing/receipt'
import type { ReceiptData } from './render'

/**
 * Map the stored invoice snapshot to print data. Amounts are copied exactly as
 * stored — a receipt never recomputes a total (see lib/billing/receipt.ts).
 * `date` is pre-formatted by the caller in the venue's timezone.
 */
export function receiptDataFromInvoice(r: InvoiceReceipt, date: string): ReceiptData {
  const captured = r.payments.filter((p) => p.status === 'captured')
  return {
    business: {
      name: r.business.legalName,
      address: r.business.address,
      phone: r.business.phone,
      gstin: r.business.gstin,
    },
    invoiceNumber: r.invoice.invoiceNumber,
    date,
    customer: r.customer?.name ?? null,
    items: r.items.map((i) => ({
      description: i.description,
      qty: i.qty,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    })),
    subtotal: r.invoice.subtotal,
    discount: r.invoice.discount,
    serviceCharge: r.invoice.serviceChargeAmount,
    cgst: r.cgstTotal,
    sgst: r.sgstTotal,
    total: r.invoice.total,
    payments: captured.map((p) => ({ method: p.method.toUpperCase(), amount: p.amount })),
    paid: r.paidTotal,
    balanceDue: r.balanceDue,
    isBill: !r.fullyPaid,
  }
}
