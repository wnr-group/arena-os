/**
 * Reading an issued invoice back for the GST receipt.
 *
 * THE RULE FOR THIS WHOLE FILE: an invoice is a historical financial snapshot.
 * Nothing here recomputes money. No priceBill(), no re-deriving GST from
 * invoice_items.tax_rate, no looking up a live resource or menu price. Every
 * figure the receipt prints is read straight off the row that was written when
 * the bill was raised.
 *
 * The one arithmetic this file does is ADDING UP stored values — summing the
 * per-rate cgst/sgst already stored in tax_breakup, and subtracting captured
 * payments from the stored total to show a balance. Both preserve the stored
 * amounts exactly and both go through round2(), the project's single money
 * helper.
 *
 * Takes a `tx` (like ./invoice.ts and ./payments.ts) so it can be exercised on
 * an RLS-scoped transaction without a request context.
 */
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import type { TaxBreakupLine } from '@/db/schema'
import { branches, customers, invoiceItems, invoices, tenants } from '@/db/schema'
import { capturedTotal, listInvoicePayments, paise, type RecordedPayment } from './payments'
import { loadBusinessProfile } from '@/lib/settings/business-profile'
import { refundsByPayment } from './refunds'
import { round2 } from './pricing'

type Db = NodePgDatabase<typeof schema>

/**
 * The letterhead — the tenant's `business_profiles` row (migration 0012).
 *
 * Each field falls back to what the rest of the database knows when the owner
 * has not configured it: the tenant's name for the legal name, the issuing
 * branch's address and phone for the address. `gstin` has NO fallback — there
 * is nowhere else to read one from — so an unconfigured profile leaves it null
 * and the receipt renders that gap visibly rather than inventing a number.
 */
export type BusinessLetterhead = {
  legalName: string
  gstin: string | null
  address: string | null
  phone: string | null
  logoUrl: string | null
}

export type ReceiptItem = {
  id: string
  kind: string
  description: string
  qty: string
  unitPrice: string
  taxRate: string
  lineTotal: string
}

export type ReceiptCustomer = { name: string | null; phone: string | null }

/** A payment plus what has been refunded against it. */
export type ReceiptPayment = RecordedPayment & {
  refunded: string
  /** payment.amount − refunded, floored at 0. What a refund dialog may offer. */
  refundable: string
}

/** One stored GST group, normalised for display. Amounts stay as stored. */
export type ReceiptTaxGroup = { rate: number; cgst: string; sgst: string; igst: string | null }

export type InvoiceReceipt = {
  invoice: {
    id: string
    invoiceNumber: string
    bookingId: string | null
    customerId: string | null
    subtotal: string
    discount: string
    /**
     * The membership half of `discount`, as it was applied (AROS-61). Read
     * straight off the invoice snapshot — the receipt never consults the
     * customer's current membership or the live plan, so a reprint years later
     * shows what was actually charged.
     */
    membershipDiscount: string
    membershipDiscountPercent: string
    membershipPlanName: string | null
    /**
     * The loyalty half of `discount`, as applied. Read off the invoice's own
     * snapshot — never from today's loyalty_settings — so a reprint years later
     * shows the rate that was actually honoured.
     */
    loyaltyPointsRedeemed: number
    loyaltyDiscount: string
    loyaltyPointValue: string
    loyaltyPointsEarned: number
    taxTotal: string
    taxBreakup: ReceiptTaxGroup[]
    total: string
    status: string
    placeOfSupply: string | null
    issuedAt: Date | null
    createdAt: Date
  }
  items: ReceiptItem[]
  payments: ReceiptPayment[]
  business: BusinessLetterhead
  customer: ReceiptCustomer | null
  /** Total refunded across every payment on this invoice. */
  refundsTotal: string
  /** Sum of the stored per-group cgst / sgst. Aggregation only, never recomputation. */
  cgstTotal: string
  sgstTotal: string
  /** Captured payments only — pending/failed/refunded are not money in the till. */
  paidTotal: string
  balanceDue: string
  fullyPaid: boolean
}

/** Sum a column of stored 2dp strings without floating drift. */
function sumStored(values: (string | null | undefined)[]): string {
  const total = values.reduce<number>((acc, v) => round2(acc + round2(Number(v ?? 0))), 0)
  return total.toFixed(2)
}

/**
 * Load everything the GST receipt prints.
 *
 * Returns null when the invoice does not exist OR belongs to another tenant —
 * RLS makes those indistinguishable, so the page can 404 without ever revealing
 * that another workspace's invoice exists.
 */
export async function loadInvoiceReceipt(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceReceipt | null> {
  const [row] = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      bookingId: invoices.bookingId,
      customerId: invoices.customerId,
      subtotal: invoices.subtotal,
      discount: invoices.discount,
      membershipDiscount: invoices.membershipDiscount,
      membershipDiscountPercent: invoices.membershipDiscountPercent,
      membershipPlanName: invoices.membershipPlanName,
      loyaltyPointsRedeemed: invoices.loyaltyPointsRedeemed,
      loyaltyDiscount: invoices.loyaltyDiscount,
      loyaltyPointValue: invoices.loyaltyPointValue,
      loyaltyPointsEarned: invoices.loyaltyPointsEarned,
      taxTotal: invoices.taxTotal,
      taxBreakup: invoices.taxBreakup,
      total: invoices.total,
      status: invoices.status,
      placeOfSupply: invoices.placeOfSupply,
      issuedAt: invoices.issuedAt,
      createdAt: invoices.createdAt,
      tenantName: tenants.name,
      branchName: branches.name,
      branchAddress: branches.address,
      branchPhone: branches.phone,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(invoices)
    .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .innerJoin(branches, eq(branches.id, invoices.branchId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    // Tenant filter in the application layer as well as RLS — the same
    // belt-and-braces the rest of lib/billing uses.
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  if (!row) return null

  // Sequential, not Promise.all: these share ONE transaction client, and a
  // Postgres connection cannot run two queries at once (pg deprecates it and
  // removes it in v9).
  const items = await tx
    .select({
      id: invoiceItems.id,
      kind: invoiceItems.kind,
      description: invoiceItems.description,
      qty: invoiceItems.qty,
      unitPrice: invoiceItems.unitPrice,
      taxRate: invoiceItems.taxRate,
      lineTotal: invoiceItems.lineTotal,
    })
    .from(invoiceItems)
    .where(and(eq(invoiceItems.tenantId, tenantId), eq(invoiceItems.invoiceId, row.id)))
    .orderBy(asc(invoiceItems.createdAt))
  const paymentRows = await listInvoicePayments(tx, tenantId, row.id)
  const paid = await capturedTotal(tx, tenantId, row.id)
  const refundMap = await refundsByPayment(tx, tenantId, row.id)

  // Refund figures are read, never recomputed: each is the stored sum for that
  // payment. `refundable` is what a refund dialog may offer, floored at zero.
  const profile = await loadBusinessProfile(tx, tenantId)

  const payments = paymentRows.map((p) => {
    const refunded = round2(Number(refundMap.get(p.id) ?? 0))
    const remaining = round2(Number(p.amount) - refunded)
    return {
      ...p,
      refunded: refunded.toFixed(2),
      refundable: (paise(remaining) > 0 ? remaining : 0).toFixed(2),
    }
  })
  const refundsTotal = payments
    .reduce((acc, p) => round2(acc + Number(p.refunded)), 0)
    .toFixed(2)

  // Stored breakup → display shape. `rate` is the column's name for the GST
  // percentage (see TaxBreakupLine in db/schema.ts); amounts are passed through
  // untouched so what prints is exactly what was stored.
  const stored = (row.taxBreakup ?? []) as TaxBreakupLine[]
  const taxBreakup: ReceiptTaxGroup[] = stored.map((g) => ({
    rate: Number(g.rate ?? 0),
    cgst: round2(Number(g.cgst ?? 0)).toFixed(2),
    sgst: round2(Number(g.sgst ?? 0)).toFixed(2),
    igst: g.igst ? round2(Number(g.igst)).toFixed(2) : null,
  }))

  const total = round2(Number(row.total))
  const balance = round2(total - paid)

  return {
    invoice: {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      bookingId: row.bookingId,
      customerId: row.customerId,
      subtotal: row.subtotal,
      discount: row.discount,
      membershipDiscount: row.membershipDiscount,
      membershipDiscountPercent: row.membershipDiscountPercent,
      membershipPlanName: row.membershipPlanName,
      loyaltyPointsRedeemed: row.loyaltyPointsRedeemed,
      loyaltyDiscount: row.loyaltyDiscount,
      loyaltyPointValue: row.loyaltyPointValue,
      loyaltyPointsEarned: row.loyaltyPointsEarned,
      taxTotal: row.taxTotal,
      taxBreakup,
      total: row.total,
      status: row.status,
      placeOfSupply: row.placeOfSupply,
      issuedAt: row.issuedAt,
      createdAt: row.createdAt,
    },
    items,
    payments,
    business: {
      legalName: profile?.legalName ?? row.tenantName,
      gstin: profile?.gstin ?? null,
      address: profile?.address ?? row.branchAddress ?? row.branchName,
      phone: row.branchPhone,
      logoUrl: profile?.logoUrl ?? null,
    },
    customer: row.customerId ? { name: row.customerName, phone: row.customerPhone } : null,
    refundsTotal,
    cgstTotal: sumStored(taxBreakup.map((g) => g.cgst)),
    sgstTotal: sumStored(taxBreakup.map((g) => g.sgst)),
    paidTotal: paid.toFixed(2),
    // Never show a negative amount owing.
    balanceDue: (paise(balance) > 0 ? balance : 0).toFixed(2),
    fullyPaid: paise(balance) <= 0,
  }
}
