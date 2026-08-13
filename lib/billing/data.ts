import 'server-only'
import { and, eq, max, min } from 'drizzle-orm'
import { withUser } from '@/db'
import { bookings, bookingSlots, branches, customers } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import {
  findLiveInvoice,
  isBillableBookingStatus,
  loadBillLines,
  loadInvoiceLines,
  type ExistingInvoice,
} from './invoice'
import { getInvoiceSettlement, type InvoiceSettlement } from './payments'
import { loadInvoiceReceipt, type InvoiceReceipt } from './receipt'
import type { BillLine } from './pricing'

/**
 * Everything the POS bill screen renders, loaded in ONE RLS-scoped transaction
 * — same shape as lib/customers/profile.ts.
 *
 * This is the PREVIEW feed. The screen prices these lines client-side purely so
 * the cashier sees totals move as they type a discount; the invoice itself is
 * built by issueInvoiceForBooking(), which re-reads all of this server-side.
 */

export type BillableBookingHeader = {
  id: string
  bookingNumber: string
  status: string
  billable: boolean
  branchId: string
  branchName: string
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  startsAt: string | null
  endsAt: string | null
  resourceNames: string[]
}

export type BillableBooking = {
  booking: BillableBookingHeader
  lines: BillLine[]
  /** Set when the booking already carries a live (non-void) invoice. */
  existingInvoice: ExistingInvoice | null
  /**
   * What that invoice costs, what has been tendered and what is left — the
   * authoritative figures behind the payment panel. Null until a bill exists.
   */
  settlement: InvoiceSettlement | null
}

/**
 * Load a booking and its billable lines. Returns null when the booking does not
 * exist OR belongs to another tenant — RLS makes those indistinguishable, which
 * is exactly what we want: guessing a bookingId from another workspace 404s.
 */
export async function getBillableForBooking(
  ctx: ActiveContext,
  bookingId: string,
): Promise<BillableBooking | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select({
        id: bookings.id,
        bookingNumber: bookings.bookingNumber,
        status: bookings.status,
        branchId: bookings.branchId,
        branchName: branches.name,
        customerId: bookings.customerId,
        bookingCustomerName: bookings.customerName,
        bookingCustomerPhone: bookings.customerPhone,
        directoryName: customers.name,
        directoryPhone: customers.phone,
      })
      .from(bookings)
      .innerJoin(branches, eq(branches.id, bookings.branchId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenant.id)))
      .limit(1)

    if (!row) return null

    // Once a bill exists, its own invoice_items are the source of truth for
    // what to display — loadBillLines() recomputes from LIVE booking_slots /
    // orders, and a billed order has deliberately dropped out of that (see
    // loadInvoiceLines' doc comment), so re-running it here would make the
    // food section vanish from a bill that already charged for it.
    const existingInvoice = await findLiveInvoice(tx, ctx.tenant.id, row.id)
    const lines = existingInvoice
      ? await loadInvoiceLines(tx, ctx.tenant.id, existingInvoice.id)
      : await loadBillLines(tx, ctx.tenant.id, row.id, ctx.tenant.timezone)
    const settlement = existingInvoice
      ? await getInvoiceSettlement(tx, ctx.tenant.id, existingInvoice.id)
      : null

    // The window shown in the header spans the same ACTIVE slots that produced
    // the lines, so header and body can never disagree.
    const [window] = await tx
      .select({ startsAt: min(bookingSlots.startsAt), endsAt: max(bookingSlots.endsAt) })
      .from(bookingSlots)
      .where(
        and(
          eq(bookingSlots.tenantId, ctx.tenant.id),
          eq(bookingSlots.bookingId, row.id),
          eq(bookingSlots.active, true),
        ),
      )

    const bookingLines = lines.filter((l) => l.kind === 'booking')

    return {
      booking: {
        id: row.id,
        bookingNumber: row.bookingNumber,
        status: row.status,
        billable: isBillableBookingStatus(row.status),
        branchId: row.branchId,
        branchName: row.branchName,
        customerId: row.customerId,
        // Prefer the directory record, fall back to the booking's own snapshot.
        customerName: row.directoryName ?? row.bookingCustomerName,
        customerPhone: row.directoryPhone ?? row.bookingCustomerPhone,
        startsAt: window?.startsAt ? new Date(window.startsAt).toISOString() : null,
        endsAt: window?.endsAt ? new Date(window.endsAt).toISOString() : null,
        resourceNames: [...new Set(bookingLines.map((l) => l.description.split(' · ')[0]))],
      },
      lines,
      existingInvoice,
      settlement,
    }
  })
}

/**
 * Everything the GST receipt at /invoices/[id] prints, in ONE RLS-scoped
 * transaction: the invoice snapshot, its line items, its payments, the
 * letterhead and the customer.
 *
 * Returns null when the invoice does not exist or belongs to another tenant —
 * the page turns that into notFound(), so an invoice id from another workspace
 * is indistinguishable from a bad one.
 *
 * Read-only and non-computing: see lib/billing/receipt.ts for why nothing here
 * may recalculate a total.
 */
export async function getInvoice(
  ctx: ActiveContext,
  invoiceId: string,
): Promise<InvoiceReceipt | null> {
  return withUser(ctx.user.id, (tx) => loadInvoiceReceipt(tx, ctx.tenant.id, invoiceId))
}
