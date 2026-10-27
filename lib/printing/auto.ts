import 'server-only'
import { withUser } from '@/db'
import { loadInvoiceReceipt } from '@/lib/billing/receipt'
import type { ActiveContext } from '@/lib/tenant/context'
import { dateTimeIn, enqueueReceiptCore } from './jobs'
import { receiptDataFromInvoice } from './receipt-data'

/**
 * Queue an invoice on the branch's receipt printer. Runs in its OWN transaction
 * after the bill is committed — a printing problem must never undo or delay
 * raising a bill. 'no_printer' means none is configured (web-print stays the
 * path); a thrown error is for the caller to surface or swallow.
 */
export async function printInvoice(ctx: ActiveContext, invoiceId: string): Promise<'queued' | 'no_printer'> {
  return withUser(ctx.user.id, async (tx) => {
    const r = await loadInvoiceReceipt(tx, ctx.tenant.id, invoiceId)
    if (!r) throw new Error('Invoice not found.')
    return enqueueReceiptCore(tx, {
      tenantId: ctx.tenant.id,
      invoiceId,
      bookingId: r.invoice.bookingId,
      data: receiptDataFromInvoice(r, dateTimeIn(ctx.tenant.timezone, r.invoice.issuedAt ?? r.invoice.createdAt)),
      membershipId: ctx.membershipId,
    })
  })
}
