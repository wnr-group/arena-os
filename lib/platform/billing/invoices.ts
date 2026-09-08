import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { DB } from '@/db'
import {
  businessProfiles,
  plans,
  platformBillingSettings,
  platformInvoices,
  tenants,
} from '@/db/schema'
import { financialYearPeriod, formatInvoiceNumber } from '@/lib/billing/invoice'
import { round2 } from '@/lib/billing/pricing'
import { todayInZone } from '@/lib/booking/time'
import { money, resolveSupplyPlace, splitGstInclusive } from './gst'
import { GATEWAY } from './lifecycle'

/**
 * Raising a platform invoice — the GST document for an Arena OS subscription
 * charge (M16 #4).
 *
 * Every function here takes a `tx` the caller has already opened, exactly like
 * lib/billing/invoice.ts does for the POS bill. That is not a style choice: the
 * number bump, the snapshot and the insert have to commit or roll back as one,
 * or a crash between them burns an invoice number and leaves a paid renewal
 * undocumented.
 *
 * ── AN INVOICE IS A HISTORICAL SNAPSHOT ─────────────────────────────────────
 *
 * The rule lib/billing/receipt.ts states for POS receipts applies here with
 * more force, because a platform invoice outlives more of what it describes.
 * Every value that appears on the document — both parties' legal name, GSTIN
 * and address, the place of supply, the plan name, the plan price, the GST rate
 * — is COPIED ONTO THE ROW when the invoice is raised. Nothing renders an old
 * invoice by reading `business_profiles` or `plans` again.
 *
 * That matters concretely: a business changes its registered address, Arena OS
 * revises its price list, the GST rate moves. None of those may retroactively
 * alter a bill that has already been paid and filed.
 *
 * ── AND THE MONEY IS WHAT THE GATEWAY ACTUALLY TOOK ─────────────────────────
 *
 * `subtotal` comes from the Razorpay PAYMENT entity, not from the catalogue.
 * The catalogue price is snapshotted beside it as `plan_price` so a divergence
 * is visible rather than reconciled away — but the invoice always totals the
 * rupees that actually moved. Anything else is a document that disagrees with
 * the bank.
 */

/** Arena OS's own billing details, with the defaults an unconfigured install gets. */
export type PlatformLetterhead = {
  sellerLegalName: string
  sellerGstin: string | null
  sellerAddress: string | null
  sellerStateCode: string | null
  gstRate: number
  invoicePrefix: string
  creditNotePrefix: string
}

/** The fallback letterhead. An install that has not configured one still bills. */
const DEFAULT_LETTERHEAD: PlatformLetterhead = {
  sellerLegalName: 'Arena OS',
  sellerGstin: null,
  sellerAddress: null,
  sellerStateCode: null,
  // The standard rate for SaaS in India. Overridable in
  // platform_billing_settings, and snapshotted onto every invoice, so this is a
  // starting value rather than a rule anything downstream depends on.
  gstRate: 18,
  invoicePrefix: 'AOS',
  creditNotePrefix: 'AOC',
}

/**
 * The platform's billing letterhead.
 *
 * Read on whatever connection the caller hands in. In practice that is always
 * the owner connection — `arena_app` has no grant on this table at all
 * (migration 0080) — because the only caller is the webhook, which has no
 * session. Tenants never read it: they read the snapshot on their own invoice.
 */
export async function loadPlatformLetterhead(tx: DB): Promise<PlatformLetterhead> {
  const [row] = await tx
    .select()
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, true))
    .limit(1)

  if (!row) return DEFAULT_LETTERHEAD

  return {
    sellerLegalName: row.sellerLegalName?.trim() || DEFAULT_LETTERHEAD.sellerLegalName,
    sellerGstin: row.sellerGstin?.trim() || null,
    sellerAddress: row.sellerAddress?.trim() || null,
    sellerStateCode: row.sellerStateCode?.trim() || null,
    gstRate: Number(row.gstRate),
    invoicePrefix: row.invoicePrefix,
    creditNotePrefix: row.creditNotePrefix,
  }
}

/**
 * The next platform invoice number, atomically.
 *
 * The same statement `nextInvoiceNumber()` in lib/billing/invoice.ts uses, and
 * the same formatter — only the counter table differs, because GST numbering
 * belongs to the SUPPLIER and Arena OS is the supplier for every one of these
 * (see migration 0080's header for why `sequences` cannot be reused).
 *
 * `insert … on conflict do update set value = value + 1 returning value` is
 * atomic: a concurrent bumper blocks on the row lock and then reads the
 * incremented value, so two simultaneous renewals cannot mint the same number.
 * There is no read-then-write window and no retry loop.
 *
 * The counter is keyed by financial year, so it restarts at 1 on 1 April, and
 * the compacted year is part of the string — which is what keeps last year's
 * first invoice and this year's first invoice different, and therefore keeps
 * the `unique (invoice_number)` constraint satisfiable forever.
 */
export async function nextPlatformInvoiceNumber(
  tx: DB,
  kind: 'invoice' | 'credit_note',
  prefix: string,
  period: string,
): Promise<string> {
  const bumped = await tx.execute<{ value: number }>(sql`
    insert into platform_sequences (kind, period, value)
    values (${kind}, ${period}, 1)
    on conflict (kind, period)
      do update set value = platform_sequences.value + 1
    returning value
  `)
  return formatInvoiceNumber(prefix, period, Number(bumped.rows[0].value))
}

/**
 * The financial year an Arena OS invoice belongs to.
 *
 * Derived in the SUPPLIER's timezone, not the tenant's and not the server's.
 * A POS invoice uses the venue's timezone because the venue is the supplier
 * there; here Arena OS is, and its numbering must not depend on which customer
 * happened to renew first on 1 April.
 */
export const PLATFORM_TIMEZONE = 'Asia/Kolkata'

export function platformInvoiceDate(now: Date = new Date()): {
  date: string
  period: string
} {
  const date = todayInZone(PLATFORM_TIMEZONE, now)
  return { date, period: financialYearPeriod(date) }
}

/** Everything the buyer half of the document needs, read once. */
type BuyerSnapshot = {
  legalName: string
  gstin: string | null
  address: string | null
  placeOfSupplyText: string | null
}

/**
 * The business's own billing identity, from `business_profiles` (0020).
 *
 * Falls back to the tenant's name for the legal name — the same fallback chain
 * lib/billing/receipt.ts uses for a POS letterhead — because a business that has
 * not filled in its profile must still receive a document with a name on it.
 * GSTIN and address have no fallback: there is nowhere else to read them from,
 * and inventing either on a tax document would be worse than leaving it blank.
 */
async function loadBuyer(tx: DB, tenantId: string): Promise<BuyerSnapshot> {
  const [row] = await tx
    .select({
      tenantName: tenants.name,
      legalName: businessProfiles.legalName,
      gstin: businessProfiles.gstin,
      address: businessProfiles.address,
      placeOfSupply: businessProfiles.placeOfSupply,
    })
    .from(tenants)
    .leftJoin(businessProfiles, eq(businessProfiles.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId))
    .limit(1)

  if (!row) throw new Error(`platform invoice: tenant ${tenantId} not found`)

  return {
    legalName: row.legalName?.trim() || row.tenantName,
    gstin: row.gstin?.trim() || null,
    address: row.address?.trim() || null,
    placeOfSupplyText: row.placeOfSupply?.trim() || null,
  }
}

export type IssueSubscriptionInvoiceParams = {
  tenantId: string
  subscriptionId: string
  planId: string
  billingPeriodType: 'monthly' | 'annual'
  billingPeriodStart: Date
  billingPeriodEnd: Date
  /**
   * The GROSS amount Razorpay captured, in rupees. Authoritative — the invoice
   * totals this, not the catalogue price.
   */
  grossAmount: number
  currency: string
  gatewayPaymentId: string
  gatewaySubscriptionId: string | null
  gatewayInvoiceId: string | null
  gatewayEventId: string | null
}

export type IssuedPlatformInvoice = {
  id: string
  invoiceNumber: string
  total: string
}

/**
 * Raise the invoice for one successful subscription charge.
 *
 * Returns null when this payment has ALREADY been invoiced — the money-level
 * idempotency rule. That is decided by
 * `idx_platform_invoices_gateway_payment` (a partial unique index on
 * (gateway, gateway_payment_id)), not by an application existence check:
 *
 *   * a redelivery of the same event never reaches here, because the event-id
 *     claim in ./webhook.ts short-circuits first;
 *   * but ONE payment can legitimately arrive under SEVERAL event ids — a
 *     retry after a 5xx, a `subscription.charged` alongside a `payment.captured`
 *     — and only the index stops that becoming two invoices, two invoice
 *     numbers and two lots of GST.
 *
 * The insert is `onConflictDoNothing` on that index precisely so two concurrent
 * deliveries resolve in Postgres rather than in a race between two `select`s.
 *
 * ── One consequence, stated so it is not a surprise ────────────────────────
 * A losing insert has already bumped the number counter, so a duplicate
 * delivery consumes an invoice number without producing an invoice — a gap in
 * the sequence. GST tolerates gaps in a series (it forbids DUPLICATES, which is
 * what the unique constraint guarantees); burning a number is the cheap side of
 * that trade, and the alternative — bumping the counter after a successful
 * insert — reintroduces the read-then-write race the counter exists to avoid.
 */
export async function issueSubscriptionInvoice(
  tx: DB,
  params: IssueSubscriptionInvoiceParams,
): Promise<IssuedPlatformInvoice | null> {
  // Cheap pre-check so the common redelivery does not burn a number at all.
  // NOT the guarantee — the unique index below is. This only avoids the cost.
  const [existing] = await tx
    .select({ id: platformInvoices.id })
    .from(platformInvoices)
    .where(
      and(
        eq(platformInvoices.gateway, GATEWAY),
        eq(platformInvoices.gatewayPaymentId, params.gatewayPaymentId),
      ),
    )
    .limit(1)
  if (existing) return null

  const letterhead = await loadPlatformLetterhead(tx)
  const buyer = await loadBuyer(tx, params.tenantId)

  const [plan] = await tx
    .select({
      name: plans.name,
      monthlyPrice: plans.monthlyPrice,
      annualPrice: plans.annualPrice,
    })
    .from(plans)
    .where(eq(plans.id, params.planId))
    .limit(1)
  if (!plan) throw new Error(`platform invoice: plan ${params.planId} not found`)

  const catalogPrice =
    params.billingPeriodType === 'monthly' ? plan.monthlyPrice : plan.annualPrice

  const supply = resolveSupplyPlace({
    sellerStateCode: letterhead.sellerStateCode,
    buyerGstin: buyer.gstin,
    buyerPlaceOfSupply: buyer.placeOfSupplyText,
  })

  // ── the invoice totals WHAT RAZORPAY CAPTURED. Nothing is netted off ─────
  //
  // This used to subtract any outstanding proration credit here, so the
  // document totalled `captured − credit`. That was wrong in a way no test
  // caught, because the tests asserted the subtraction rather than questioning
  // it. Nothing reduces the actual charge: ./proration.ts:9-26 is explicit that
  // a plan change creates a NEW Razorpay subscription which "charges its plan's
  // FULL price on its first cycle". So the money in the bank was the full
  // amount while the invoice said less, which meant:
  //
  //   * the customer paid the credit and never received it — a switch cost
  //     them the credited rupees permanently, and the note was stamped 'paid'
  //     as though it had been honoured;
  //   * output GST was declared on the reduced figure while tax was collected
  //     on the full one;
  //   * readRevenue() sums `total`, so every applied credit quietly understated
  //     platform revenue;
  //   * and the invoice disagreed with the bank statement — the exact outcome
  //     ./renewal.ts:32-38 says is "worse than no invoice".
  //
  // A credit note now stays OUTSTANDING (`status = 'issued'`) until somebody
  // settles it deliberately — a refund through ./refunds.ts, or a comp through
  // ./overrides.ts. It is a real obligation to the customer and it is visible
  // as one on the owner's billing page, rather than being cancelled against
  // paperwork the customer never benefited from.
  const gross = round2(Math.max(0, params.grossAmount))

  const gst = splitGstInclusive(gross, letterhead.gstRate, supply.interstate)

  const { date, period } = platformInvoiceDate()
  const invoiceNumber = await nextPlatformInvoiceNumber(
    tx,
    'invoice',
    letterhead.invoicePrefix,
    period,
  )

  const [row] = await tx
    .insert(platformInvoices)
    .values({
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      planId: params.planId,
      kind: 'subscription',
      invoiceNumber,
      invoiceDate: date,
      period,
      billingPeriodStart: params.billingPeriodStart,
      billingPeriodEnd: params.billingPeriodEnd,
      billingPeriodType: params.billingPeriodType,
      planName: plan.name,
      planPrice: catalogPrice,
      sellerLegalName: letterhead.sellerLegalName,
      sellerGstin: letterhead.sellerGstin,
      sellerAddress: letterhead.sellerAddress,
      sellerStateCode: letterhead.sellerStateCode,
      buyerLegalName: buyer.legalName,
      buyerGstin: buyer.gstin,
      buyerAddress: buyer.address,
      buyerStateCode: supply.stateCode,
      placeOfSupply: supply.placeOfSupply,
      subtotal: money(gross),
      // Always zero now. The column stays because migration 0080 defines it and
      // `adjustment <= subtotal` still guards it, and because a future
      // gateway-side discount (a Razorpay offer, which WOULD reduce the capture)
      // is exactly what it is for.
      adjustment: money(0),
      taxableValue: money(gst.taxableValue),
      gstRate: money(letterhead.gstRate),
      cgst: money(gst.cgst),
      sgst: money(gst.sgst),
      igst: money(gst.igst),
      taxTotal: money(gst.taxTotal),
      total: money(gst.total),
      currency: params.currency,
      // Paid by definition: this row exists because Razorpay captured the money.
      status: 'paid',
      gateway: GATEWAY,
      gatewayPaymentId: params.gatewayPaymentId,
      gatewaySubscriptionId: params.gatewaySubscriptionId,
      gatewayInvoiceId: params.gatewayInvoiceId,
      gatewayEventId: params.gatewayEventId,
      notes: null,
    })
    // The real idempotency guarantee: a concurrent delivery that got past the
    // pre-check above loses HERE, in Postgres, and returns no row.
    .onConflictDoNothing({
      target: [platformInvoices.gateway, platformInvoices.gatewayPaymentId],
      // idx_platform_invoices_gateway_payment is PARTIAL, so its predicate has
      // to be restated here: without it Postgres cannot match the arbiter and
      // raises "no unique or exclusion constraint matching the ON CONFLICT
      // specification" instead of quietly doing nothing.
      where: sql`${platformInvoices.gatewayPaymentId} is not null`,
    })
    .returning({
      id: platformInvoices.id,
      invoiceNumber: platformInvoices.invoiceNumber,
      total: platformInvoices.total,
    })

  if (!row) return null


  return row
}

// ── proration credit ─────────────────────────────────────────────────────────

export type IssueCreditNoteParams = {
  tenantId: string
  subscriptionId: string
  planId: string
  billingPeriodType: 'monthly' | 'annual'
  billingPeriodStart: Date
  billingPeriodEnd: Date
  /** The GROSS credit, in rupees. Must be > 0; the caller computes it. */
  grossAmount: number
  currency: string
  reason: string
}

/**
 * Raise a credit note for the unused remainder of a period.
 *
 * A credit note carries POSITIVE amounts and its own number series. That is
 * both what GST expects and what keeps migration 0080's `total >= 0` check
 * meaningful: a negative invoice is unrepresentable in this schema, so
 * proration cannot accidentally produce one.
 *
 * It has no `gateway_payment_id` — no money moved — which is enforced by the
 * `platform_invoices_credit_note_unpaid` constraint.
 */
export async function issueCreditNote(
  tx: DB,
  params: IssueCreditNoteParams,
): Promise<IssuedPlatformInvoice | null> {
  const gross = round2(Math.max(0, params.grossAmount))
  if (gross <= 0) return null

  const letterhead = await loadPlatformLetterhead(tx)
  const buyer = await loadBuyer(tx, params.tenantId)

  const [plan] = await tx
    .select({
      name: plans.name,
      monthlyPrice: plans.monthlyPrice,
      annualPrice: plans.annualPrice,
    })
    .from(plans)
    .where(eq(plans.id, params.planId))
    .limit(1)
  if (!plan) throw new Error(`credit note: plan ${params.planId} not found`)

  const supply = resolveSupplyPlace({
    sellerStateCode: letterhead.sellerStateCode,
    buyerGstin: buyer.gstin,
    buyerPlaceOfSupply: buyer.placeOfSupplyText,
  })

  // The credit is GST-inclusive for the same reason the charge is: it reverses
  // part of a tax-inclusive amount, so the tax inside it reverses too.
  const gst = splitGstInclusive(gross, letterhead.gstRate, supply.interstate)

  const { date, period } = platformInvoiceDate()
  const invoiceNumber = await nextPlatformInvoiceNumber(
    tx,
    'credit_note',
    letterhead.creditNotePrefix,
    period,
  )

  const [row] = await tx
    .insert(platformInvoices)
    .values({
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      planId: params.planId,
      kind: 'credit_note',
      invoiceNumber,
      invoiceDate: date,
      period,
      billingPeriodStart: params.billingPeriodStart,
      billingPeriodEnd: params.billingPeriodEnd,
      billingPeriodType: params.billingPeriodType,
      planName: plan.name,
      planPrice:
        params.billingPeriodType === 'monthly' ? plan.monthlyPrice : plan.annualPrice,
      sellerLegalName: letterhead.sellerLegalName,
      sellerGstin: letterhead.sellerGstin,
      sellerAddress: letterhead.sellerAddress,
      sellerStateCode: letterhead.sellerStateCode,
      buyerLegalName: buyer.legalName,
      buyerGstin: buyer.gstin,
      buyerAddress: buyer.address,
      buyerStateCode: supply.stateCode,
      placeOfSupply: supply.placeOfSupply,
      subtotal: money(gross),
      adjustment: '0.00',
      taxableValue: money(gst.taxableValue),
      gstRate: money(letterhead.gstRate),
      cgst: money(gst.cgst),
      sgst: money(gst.sgst),
      igst: money(gst.igst),
      taxTotal: money(gst.taxTotal),
      total: money(gst.total),
      currency: params.currency,
      // 'issued' = outstanding. Flipped to 'paid' when set against a charge.
      status: 'issued',
      gateway: GATEWAY,
      notes: params.reason,
    })
    .returning({
      id: platformInvoices.id,
      invoiceNumber: platformInvoices.invoiceNumber,
      total: platformInvoices.total,
    })

  return row ?? null
}

/**
 * The most recent PAID subscription invoice for a subscription.
 *
 * The proration base: what the business actually paid for the period it is now
 * leaving. Read from the invoice rather than from the plan catalogue, so a
 * price change between the charge and the switch cannot inflate a credit.
 */
export async function lastPaidInvoiceFor(tx: DB, subscriptionId: string) {
  const [row] = await tx
    .select({
      id: platformInvoices.id,
      total: platformInvoices.total,
      billingPeriodStart: platformInvoices.billingPeriodStart,
      billingPeriodEnd: platformInvoices.billingPeriodEnd,
      billingPeriodType: platformInvoices.billingPeriodType,
      planId: platformInvoices.planId,
      currency: platformInvoices.currency,
    })
    .from(platformInvoices)
    .where(
      and(
        eq(platformInvoices.subscriptionId, subscriptionId),
        eq(platformInvoices.kind, 'subscription'),
      ),
    )
    .orderBy(desc(platformInvoices.createdAt))
    .limit(1)
  return row ?? null
}
