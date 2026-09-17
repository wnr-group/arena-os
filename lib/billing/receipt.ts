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
import { branches, customers, invoiceItems, invoices, promoCodes, tenants } from '@/db/schema'
import { capturedTotal, listInvoicePayments, paise, type RecordedPayment } from './payments'
import { loadBusinessProfile } from '@/lib/settings/business-profile'
import { refundsByPayment } from './refunds'
import { round2, type PricingResult } from './pricing'

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
     * The promo code this bill honoured, and the part of `discount` it took
     * off. Null when no code was used — or when the code row was hard-deleted,
     * which the composite FK turns into a null reference rather than a dangling
     * one. Codes are DEACTIVATED rather than deleted and their `code` is never
     * edited (see lib/actions/promo-codes.ts), so a reprint years later names
     * the same code the customer was quoted.
     */
    promoCode: string | null
    promoDiscount: string
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
    /**
     * Service charge (M18 #3), frozen at issue — already folded into
     * taxTotal/taxBreakup/total above, never a separate figure to add on
     * top. serviceChargeAmount is '0.00' when the tenant had it off.
     */
    serviceChargePercent: string
    serviceChargeAmount: string
    serviceChargeTaxPercent: string
    /** Running aggregate of every captured payment's tip (M18 #3) — NOT
     *  part of total/balanceDue, extra money on top of the bill. */
    tipAmount: string
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
 * An issued invoice's OWN pricing, in the shape priceBill() returns.
 *
 * For screens that show a bill both before and after it is raised. Before, the
 * figures come from priceBill(); after, they must come from here — because the
 * two are not interchangeable:
 *
 *   * `invoice_items.qty` is numeric(10,2), so a 1h20m slot is stored as 1.33.
 *     Re-multiplying 1.33 × ₹400 gives ₹532, not the ₹533.33 that was charged.
 *     The stored `line_total` is the only true figure.
 *   * a re-price knows nothing about the discount that was applied, so every
 *     GST amount and the grand total come out too high.
 *
 * Same rule as the rest of this file, therefore: nothing here is recomputed.
 * `taxableValue` is the one subtraction — subtotal − discount, both stored, the
 * same arithmetic priceBill did when the bill was raised (invoices carries no
 * taxable_value column to read instead).
 *
 * Returns null when the invoice does not exist or belongs to another tenant.
 */
export async function loadIssuedPricing(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<PricingResult | null> {
  const [row] = await tx
    .select({
      id: invoices.id,
      subtotal: invoices.subtotal,
      discount: invoices.discount,
      taxTotal: invoices.taxTotal,
      taxBreakup: invoices.taxBreakup,
      total: invoices.total,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  if (!row) return null

  const items = await tx
    .select({
      kind: invoiceItems.kind,
      description: invoiceItems.description,
      sourceId: invoiceItems.sourceId,
      qty: invoiceItems.qty,
      unitPrice: invoiceItems.unitPrice,
      taxRate: invoiceItems.taxRate,
      lineTotal: invoiceItems.lineTotal,
    })
    .from(invoiceItems)
    .where(and(eq(invoiceItems.tenantId, tenantId), eq(invoiceItems.invoiceId, row.id)))
    .orderBy(asc(invoiceItems.createdAt))

  const subtotal = round2(Number(row.subtotal))
  const discount = round2(Number(row.discount))
  const stored = (row.taxBreakup ?? []) as TaxBreakupLine[]

  return {
    subtotal,
    discount,
    taxableValue: round2(subtotal - discount),
    // `percent` is priceBill's name for the column's `rate` — the same mapping
    // issueInvoiceForBooking made when it wrote the row, read back.
    taxBreakup: stored.map((g) => ({
      percent: Number(g.rate ?? 0),
      cgst: round2(Number(g.cgst ?? 0)),
      sgst: round2(Number(g.sgst ?? 0)),
    })),
    taxTotal: round2(Number(row.taxTotal)),
    total: round2(Number(row.total)),
    items: items.map((i) => ({
      description: i.description,
      kind: i.kind,
      sourceId: i.sourceId ?? undefined,
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      taxPercent: Number(i.taxRate),
      // Read, never qty × unitPrice — see the note above.
      lineTotal: round2(Number(i.lineTotal)),
    })),
  }
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
      promoCode: promoCodes.code,
      taxTotal: invoices.taxTotal,
      taxBreakup: invoices.taxBreakup,
      total: invoices.total,
      status: invoices.status,
      placeOfSupply: invoices.placeOfSupply,
      issuedAt: invoices.issuedAt,
      createdAt: invoices.createdAt,
      serviceChargePercent: invoices.serviceChargePercent,
      serviceChargeAmount: invoices.serviceChargeAmount,
      serviceChargeTaxPercent: invoices.serviceChargeTaxPercent,
      tipAmount: invoices.tipAmount,
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
    // Composite, matching the invoices_promo_fk the row was written under, so
    // the join can no more reach another tenant's promo than the FK could.
    .leftJoin(
      promoCodes,
      and(eq(promoCodes.tenantId, invoices.tenantId), eq(promoCodes.id, invoices.promoCodeId)),
    )
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

  // The promo's share of `discount`. The invoice snapshots WHICH code was
  // honoured but not what it took off, because a promo is never an amount
  // alongside the discount — `discount` is the sum of its parts, and the other
  // two parts are each stored. Subtracting them leaves the promo's exactly: a
  // code REPLACES a keyed-in figure rather than stacking with it (step 4b of
  // issueInvoiceForBooking), so when an invoice cites a code the remainder is
  // all of it. Subtraction of stored values, in the spirit of the rule at the
  // top of this file — nothing here is repriced.
  const promoDiscount = row.promoCode
    ? Math.max(
        0,
        round2(
          Number(row.discount) - Number(row.membershipDiscount) - Number(row.loyaltyDiscount),
        ),
      )
    : 0

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
      promoCode: row.promoCode,
      promoDiscount: promoDiscount.toFixed(2),
      taxTotal: row.taxTotal,
      taxBreakup,
      total: row.total,
      status: row.status,
      placeOfSupply: row.placeOfSupply,
      issuedAt: row.issuedAt,
      createdAt: row.createdAt,
      serviceChargePercent: row.serviceChargePercent,
      serviceChargeAmount: row.serviceChargeAmount,
      serviceChargeTaxPercent: row.serviceChargeTaxPercent,
      tipAmount: row.tipAmount,
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
