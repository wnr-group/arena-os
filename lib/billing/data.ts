import 'server-only'
import { and, asc, eq, inArray, max, min, ne, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import {
  bookings,
  bookingSlots,
  branches,
  customers,
  invoices,
  memberships,
  menuItems,
  orderItems,
  orders,
  payments,
  refunds,
  resources,
  taxRates,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import {
  findLiveBilling,
  findLiveInvoice,
  isBillableBookingStatus,
  loadBillLines,
  loadInvoiceLines,
  type ExistingInvoice,
} from './invoice'
import {
  resolveMembershipBenefit,
  type AppliedMembershipBenefit,
} from './membership-benefit'
import { loyaltyTenderState, type LoyaltyRule } from './loyalty'
import { getInvoiceSettlement, paise, type InvoiceSettlement } from './payments'
import { walletTenderState } from './wallet-payments'
import { loadInvoiceReceipt, loadIssuedPricing, type InvoiceReceipt } from './receipt'
import { priceBill, round2, type BillLine, type PricingResult, type ServiceChargeConfig } from './pricing'
import { loadServiceChargeConfig } from '@/lib/settings/business-profile'
import { validatePromo, type PromoValidation } from './promo'

/**
 * Food lines whose SNAPSHOTTED tax rate no longer matches the menu item's rate.
 *
 * An order freezes the item's name, price and tax the moment it is taken
 * (lib/orders/service.ts), and the bill copies that snapshot onto the invoice.
 * That is the right behaviour for a tax document — reading the live rate would
 * retroactively re-tax food already served and silently move the GST on bills
 * already issued — but it has a visible edge: an order that was open when a
 * rate changed will bill at the OLD rate while the menu screen shows the new
 * one, and nothing on screen says why.
 *
 * So the difference is surfaced rather than resolved. Advisory only: nothing
 * here is written, nothing is re-priced, and the bill still charges the
 * snapshot. It exists so the till sees the discrepancy BEFORE raising the bill,
 * while re-taking the line is still free.
 *
 * Only ever reports lines that would go on the NEXT bill — the same open,
 * accepted, unvoided orders loadFoodLines() bills — so a frozen invoice never
 * raises a warning about a decision that can no longer be changed.
 *
 * A line whose menu item has since been deleted reports nothing: there is no
 * current rate to compare against, and the snapshot is all that is left.
 */
export type TaxRateDrift = {
  /** The item as the order named it, so it matches the line on screen. */
  description: string
  /** The rate stored on the order — what the bill WILL charge. */
  chargedPercent: number
  /** The menu item's rate today. 0 when its tax rate was deleted. */
  currentPercent: number
}

async function loadTaxRateDrift(
  tx: Parameters<typeof loadBillLines>[0],
  tenantId: string,
  bookingId: string,
): Promise<TaxRateDrift[]> {
  const rows = await tx
    .select({
      description: orderItems.itemName,
      chargedPercent: orderItems.taxRate,
      menuItemId: menuItems.id,
      currentPercent: taxRates.percent,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    // Inner: a line whose menu item is gone has nothing to compare against.
    .innerJoin(menuItems, eq(menuItems.id, orderItems.menuItemId))
    // Left: the item may have had its tax rate cleared, or the rate deleted
    // (menu_items.tax_rate_id is ON DELETE SET NULL) — which reads as 0%, and
    // is exactly the kind of silent change worth warning about.
    .leftJoin(taxRates, eq(taxRates.id, menuItems.taxRateId))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.bookingId, bookingId),
        eq(orders.status, 'open'),
        eq(orders.acceptanceStatus, 'accepted'),
        eq(orderItems.voidStatus, 'active'),
      ),
    )
    .orderBy(orderItems.id)

  const drift: TaxRateDrift[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const charged = round2(Number(r.chargedPercent))
    const current = round2(Number(r.currentPercent ?? 0))
    if (charged === current) continue
    // One warning per item per bill, however many times it was ordered — the
    // cashier needs the fact, not a line for every cup of coffee.
    const key = `${r.description}|${charged}|${current}`
    if (seen.has(key)) continue
    seen.add(key)
    drift.push({ description: r.description, chargedPercent: charged, currentPercent: current })
  }
  return drift
}

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

/** One check of a split bill (M18 #2) — the same shape a normal invoice's
 *  display data has, plus its position in the split. */
export type CheckView = {
  invoiceId: string
  invoiceNumber: string
  seq: number
  status: string
  lines: BillLine[]
  settlement: InvoiceSettlement
  /** This check's OWN wallet spend limit — capped at its own remaining
   *  balance, not the whole split's, since each check settles independently. */
  wallet: { balance: number; maxSpendable: number } | null
}

export type BillableBooking = {
  booking: BillableBookingHeader
  lines: BillLine[]
  /** Set when the booking already carries a live (non-void) SINGLE invoice —
   *  null when the booking has never been billed, OR when it's been split
   *  (see `splitChecks` instead; the two are mutually exclusive). */
  existingInvoice: ExistingInvoice | null
  /**
   * What that invoice costs, what has been tendered and what is left — the
   * authoritative figures behind the payment panel. Null until a bill exists.
   */
  settlement: InvoiceSettlement | null
  /**
   * The issued invoice's OWN pricing, read from its stored snapshot. Null
   * until a bill exists, and once one does this — not a client-side re-price
   * of `lines` — is what the screen must show.
   *
   * Pricing is frozen at issue, and a re-price cannot reproduce it: the stored
   * qty is 2dp (a 1h20m slot re-multiplies to ₹532 instead of the ₹533.33
   * charged) and a re-price knows nothing of the discount that was applied, so
   * every GST figure and the total come out too high. See loadIssuedPricing().
   */
  issuedPricing: PricingResult | null
  /**
   * The membership benefit this bill is entitled to (AROS-61) — DISPLAY ONLY.
   *
   * Resolved through the same helper issueInvoiceForBooking() uses, so the
   * preview can never drift from what is actually charged. Nothing here is
   * persisted: the invoice path re-reads and re-applies the benefit as the
   * single authoritative application.
   */
  membership: AppliedMembershipBenefit | null
  /**
   * The customer's wallet balance and what may be spent against THIS bill.
   * Null when the invoice has no customer. DISPLAY ONLY — every limit is
   * re-checked under a lock by recordWalletPaymentForInvoice().
   */
  wallet: { balance: number; maxSpendable: number } | null
  /**
   * The customer's points balance and the tenant's rule, for the redemption
   * control. DISPLAY ONLY — the discount is priced and the debit taken
   * server-side when the bill is raised.
   */
  loyalty: { balance: number; rule: LoyaltyRule } | null
  /**
   * Lines that will be billed at a tax rate the menu no longer uses — see
   * loadTaxRateDrift(). Empty once an invoice exists: the pricing is frozen by
   * then, so the warning would only be noise.
   */
  taxDrift: TaxRateDrift[]
  /**
   * Every check of a split bill (M18 #2), ordered by bill_group_seq — null
   * for a booking that was never split. Mutually exclusive with
   * `existingInvoice`/`settlement`: a booking is either unbilled, billed as
   * one invoice, or split into N checks, never more than one of the three.
   */
  splitChecks: CheckView[] | null
  /**
   * The tenant's service charge config (M18 #3), for the pre-bill live
   * preview only — DISPLAY ONLY, same trust model as `membership` above.
   * Once a bill exists (single or split), the FROZEN serviceChargePercent
   * on that invoice/check is what actually applied; this is meaningless at
   * that point and the screen doesn't read it.
   */
  serviceChargeConfig: ServiceChargeConfig
  /** Active staff, for the tip-recipient picker on the payment panel(s). */
  staff: { id: string; name: string }[]
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
        // M17: a table session links straight to its resource (0071) instead
        // of booking_slots, so its name has to come from here rather than
        // from a booking-kind line below.
        tableResourceName: resources.name,
      })
      .from(bookings)
      .innerJoin(branches, eq(branches.id, bookings.branchId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .leftJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenant.id)))
      .limit(1)

    if (!row) return null

    // Once a bill exists, its own invoice_items are the source of truth for
    // what to display — loadBillLines() recomputes from LIVE booking_slots /
    // orders, and a billed order has deliberately dropped out of that (see
    // loadInvoiceLines' doc comment), so re-running it here would make the
    // food section vanish from a bill that already charged for it.
    const liveBilling = await findLiveBilling(tx, ctx.tenant.id, row.id)
    const existingInvoice = liveBilling?.kind === 'single' ? liveBilling.invoice : null
    const settlement = existingInvoice
      ? await getInvoiceSettlement(tx, ctx.tenant.id, existingInvoice.id)
      : null
    const issuedPricing = existingInvoice
      ? await loadIssuedPricing(tx, ctx.tenant.id, existingInvoice.id)
      : null

    // A split bill's checks are loaded sequentially — same "one connection,
    // one query at a time" discipline as loadBillLines above — each with its
    // own frozen lines and settlement, exactly like the single-invoice case
    // just does N times over.
    let splitChecks: CheckView[] | null = null
    if (liveBilling?.kind === 'split') {
      splitChecks = []
      for (const c of liveBilling.checks) {
        const checkSettlement = await getInvoiceSettlement(tx, ctx.tenant.id, c.id)
        // findLiveBilling just read this exact invoice id inside the SAME
        // transaction — it cannot have vanished a moment later.
        if (!checkSettlement) throw new Error(`Settlement missing for check invoice ${c.id}.`)
        splitChecks.push({
          invoiceId: c.id,
          invoiceNumber: c.invoiceNumber,
          seq: c.billGroupSeq,
          status: c.status,
          lines: await loadInvoiceLines(tx, ctx.tenant.id, c.id),
          settlement: checkSettlement,
          wallet: await walletTenderState(tx, ctx.tenant.id, c.id),
        })
      }
    }

    const lines = existingInvoice
      ? await loadInvoiceLines(tx, ctx.tenant.id, existingInvoice.id)
      : splitChecks
        ? splitChecks.flatMap((c) => c.lines)
        : await loadBillLines(tx, ctx.tenant.id, row.id, ctx.tenant.timezone)

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

    // The membership benefit, for DISPLAY on the bill screen. Priced against the
    // undiscounted subtotal, exactly as issueInvoiceForBooking() does, through
    // the same helper — so the figure the cashier sees is the figure that gets
    // charged. The customer comes off the booking row, never from the caller.
    const membership = await resolveMembershipBenefit(
      tx,
      ctx.tenant.id,
      row.customerId,
      priceBill({ lines }).subtotal,
    )

    // Points balance + rule, for the redemption control on the bill form.
    const loyalty = await loyaltyTenderState(tx, ctx.tenant.id, row.customerId)

    // Only worth asking before the bill exists — afterwards nothing can act
    // on the answer.
    const taxDrift = existingInvoice ? [] : await loadTaxRateDrift(tx, ctx.tenant.id, row.id)

    // Wallet state for the payment panel, once a bill exists to spend against.
    const wallet = existingInvoice
      ? await walletTenderState(tx, ctx.tenant.id, existingInvoice.id)
      : null

    // Live config for the pre-bill preview (M18 #3) — meaningless once a
    // bill exists, see the field's own doc comment.
    const serviceChargeConfig = await loadServiceChargeConfig(tx, ctx.tenant.id)

    // Every active staff member, for the tip-recipient picker — not
    // branch-filtered, since an owner/manager (often branchId=null) should
    // still be a valid recipient at a single-branch tenant.
    const staffRows = await tx
      .select({ id: memberships.id, name: memberships.fullName })
      .from(memberships)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.fullName))
    const staff = staffRows.map((s) => ({ id: s.id, name: s.name ?? 'Unnamed staff' }))

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
        resourceNames:
          bookingLines.length > 0
            ? [...new Set(bookingLines.map((l) => l.description.split(' · ')[0]))]
            : row.tableResourceName
              ? [row.tableResourceName]
              : [],
      },
      lines,
      existingInvoice,
      settlement,
      issuedPricing,
      splitChecks,
      membership,
      wallet,
      loyalty,
      taxDrift,
      serviceChargeConfig,
      staff,
    }
  })
}

/**
 * What a promo code would take off THIS booking's bill, without raising it.
 *
 * The bill screen cannot price a code itself — the discount lives in the
 * promo_codes row, and a percentage is a percentage OF a subtotal the browser
 * must not be trusted to state. So the figure is computed here, server-side,
 * from the same lines, the same membership benefit and the same validatePromo()
 * that issueInvoiceForBooking() uses, against the same base: what remains after
 * the membership benefit. What the cashier is shown is therefore the figure
 * that will actually be charged, not an optimistic guess.
 *
 * Read-only by construction: validatePromo() records nothing, so previewing a
 * code — however many times the cashier retypes it — can never burn a use. The
 * use is taken only by the invoice transaction (see consumePromoUse).
 */
export async function previewPromoForBooking(
  ctx: ActiveContext,
  bookingId: string,
  code: string,
): Promise<PromoValidation> {
  return withUser(ctx.user.id, async (tx): Promise<PromoValidation> => {
    const [row] = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        customerId: bookings.customerId,
      })
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenant.id)))
      .limit(1)

    // Same silence as getBillableForBooking: a booking from another workspace is
    // indistinguishable from one that does not exist.
    if (!row) return { ok: false, reason: 'Booking not found.' }
    if (!isBillableBookingStatus(row.status)) {
      return { ok: false, reason: 'This booking cannot be billed in its current status.' }
    }

    const existingInvoice = await findLiveInvoice(tx, ctx.tenant.id, row.id)
    if (existingInvoice) {
      return {
        ok: false,
        reason: `This booking has already been billed (${existingInvoice.invoiceNumber}).`,
      }
    }

    const lines = await loadBillLines(tx, ctx.tenant.id, row.id, ctx.tenant.timezone)
    if (lines.length === 0) return { ok: false, reason: 'This booking has nothing to bill.' }

    const subtotal = priceBill({ lines }).subtotal
    const membership = await resolveMembershipBenefit(
      tx,
      ctx.tenant.id,
      row.customerId,
      subtotal,
    )
    // The promo's base — exactly step 4b of issueInvoiceForBooking().
    const afterMembership = round2(subtotal - (membership?.discountAmount ?? 0))

    return validatePromo(tx, ctx.tenant.id, code, afterMembership)
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

/**
 * Where each booking stands with the till — billed? paid? still owing?
 *
 * The booking list shows one row per booking, so this is ONE pair of queries
 * for the whole day rather than getInvoiceSettlement() per row. It reports the
 * same figures that panel does, derived the same way: `paid` is CAPTURED
 * payments only (pending and failed tenders are not money in the till), and
 * the balance is total − paid.
 *
 * Money that has gone back out is reported as its own state rather than
 * subtracted: a refunded bill was paid AND refunded, which is two facts, and
 * collapsing them into "unpaid" would lose the first one. So `total`, `paid`
 * and `balance` stay exactly what getInvoiceSettlement() reports for the same
 * invoice — the badge can never contradict the payment panel — and `refunded`
 * sits beside them, the way the receipt prints `refundsTotal` beside its own
 * paid and balance figures.
 *
 * A refund never changes a payment's status (it stays `captured`; the refund
 * is a row of its own against it — see lib/billing/refunds.ts), which is why
 * this has to be summed separately rather than falling out of `paid`.
 *
 * Voided invoices are skipped, so a booking whose bill was voided reads as
 * unbilled again and can be re-billed — the same rule findLiveInvoice() uses.
 * Note that a manager must refund a bill BEFORE voiding it, so a fully
 * refunded bill often becomes a voided one moments later and drops back to
 * unbilled; this reports whichever state the invoice is actually in.
 */
export type BookingPaymentStatus =
  | 'issued'
  | 'partially_paid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'

export type BookingPaymentState = {
  status: BookingPaymentStatus
  invoiceId: string
  invoiceNumber: string
  /** Rupees, 2dp — the stored invoice total, never recomputed. */
  total: number
  paid: number
  balance: number
  /** Rupees given back across every payment on this bill. 0 when none were. */
  refunded: number
}

export async function listBookingPaymentStates(
  ctx: ActiveContext,
  bookingIds: string[],
): Promise<Record<string, BookingPaymentState>> {
  if (bookingIds.length === 0) return {}
  return withUser(ctx.user.id, async (tx) => {
    const invoiceRows = await tx
      .select({
        id: invoices.id,
        bookingId: invoices.bookingId,
        invoiceNumber: invoices.invoiceNumber,
        total: invoices.total,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.tenant.id),
          inArray(invoices.bookingId, bookingIds),
          ne(invoices.status, 'void'),
        ),
      )
    if (invoiceRows.length === 0) return {}

    // Sequential, not Promise.all: these share ONE transaction client, and a
    // Postgres connection cannot run two queries at once.
    const paidRows = await tx
      .select({
        invoiceId: payments.invoiceId,
        paid: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, ctx.tenant.id),
          inArray(
            payments.invoiceId,
            invoiceRows.map((r) => r.id),
          ),
          eq(payments.status, 'captured'),
        ),
      )
      .groupBy(payments.invoiceId)

    const paidByInvoice = new Map(paidRows.map((r) => [r.invoiceId, round2(Number(r.paid))]))

    // Refunds hang off the PAYMENT, not the invoice, so they come back through
    // the payment that funded them.
    const refundRows = await tx
      .select({
        invoiceId: payments.invoiceId,
        refunded: sql<string>`coalesce(sum(${refunds.amount}), 0)::text`,
        // Refunds taken against money the till still counts as captured.
        // recordRefund() flips a payment to 'refunded' only when it is FULLY
        // refunded, at which point it drops out of `paid` and its refunds are
        // already accounted for there. A partial refund leaves the payment
        // 'captured' at its full amount, so its refunds have to be subtracted
        // separately to know what is genuinely still held.
        againstHeld: sql<string>`coalesce(sum(${refunds.amount}) filter (where ${payments.status} = 'captured'), 0)::text`,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(
        and(
          eq(refunds.tenantId, ctx.tenant.id),
          inArray(
            payments.invoiceId,
            invoiceRows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(payments.invoiceId)

    const refundedByInvoice = new Map(
      refundRows.map((r) => [
        r.invoiceId,
        { total: round2(Number(r.refunded)), againstHeld: round2(Number(r.againstHeld)) },
      ]),
    )

    const out: Record<string, BookingPaymentState> = {}
    for (const inv of invoiceRows) {
      if (!inv.bookingId) continue
      const total = round2(Number(inv.total))
      const paid = paidByInvoice.get(inv.id) ?? 0
      const refundRow = refundedByInvoice.get(inv.id)
      const refunded = refundRow?.total ?? 0
      // What the business is actually still holding on this bill.
      const netHeld = round2(paid - (refundRow?.againstHeld ?? 0))
      const balance = round2(total - paid)
      // paise(), never `>=` on rupees: floats that look equal compare wrong,
      // and this decides whether a bill reads as settled.
      //
      // A refund outranks how much was paid, because it is the more recent and
      // the more surprising fact about the bill: "Paid" on a till list that has
      // just handed the money back is the reading worth preventing.
      const status: BookingPaymentStatus =
        paise(refunded) > 0
          ? paise(netHeld) <= 0
            ? 'refunded'
            : 'partially_refunded'
          : paise(balance) <= 0
            ? 'paid'
            : paise(paid) > 0
              ? 'partially_paid'
              : 'issued'
      out[inv.bookingId] = {
        status,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        total,
        paid,
        refunded,
        // Never show a negative amount owing — same floor the receipt applies.
        balance: paise(balance) > 0 ? balance : 0,
      }
    }
    return out
  })
}

export type BookingBillingState = {
  /** Current open-orders total (not yet billed) — the floor map's running tab. */
  runningTotal: number
  /** Whether the booking already has a live (non-void) invoice — see
   *  lib/booking/table-status.ts, where this is the "needs_cleaning" signal. */
  hasLiveInvoice: boolean
}

/**
 * Per-booking billing snapshot for the M17 floor map: TWO batched queries for
 * every booking (not one round trip per booking), same tenant/status filters
 * as loadFoodLines/findLiveInvoice (lib/billing/invoice.ts) — just grouped in
 * memory afterward instead of called once per id, the same "read once, group
 * in memory" shape this PR already uses elsewhere (e.g. lib/kots/data.ts's
 * loadModifierNamesByItem). FloorView.tsx polls this every few seconds for
 * every occupied table on the branch, so a per-booking loop here was 2×N
 * queries on every poll — this collapses it to 2 regardless of N.
 */
export async function listBookingBillingStates(
  ctx: ActiveContext,
  bookingIds: string[],
): Promise<Record<string, BookingBillingState>> {
  if (bookingIds.length === 0) return {}
  return withUser(ctx.user.id, async (tx) => {
    // Sequential, not Promise.all: these share ONE transaction client, and a
    // Postgres connection cannot run two queries at once (pg deprecates it and
    // removes it in v9).
    // Same shape/filter as loadFoodLines, batched across every booking.
    const foodRows = await tx
      .select({
        bookingId: orders.bookingId,
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        unitPrice: orderItems.unitPrice,
        taxRate: orderItems.taxRate,
        qty: orderItems.qty,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenant.id),
          inArray(orders.bookingId, bookingIds),
          eq(orders.status, 'open'),
          eq(orders.acceptanceStatus, 'accepted'),
          eq(orderItems.voidStatus, 'active'),
        ),
      )
    // Same shape/filter as findLiveInvoice, batched across every booking.
    const invoiceRows = await tx
      .select({ bookingId: invoices.bookingId })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.tenant.id),
          inArray(invoices.bookingId, bookingIds),
          ne(invoices.status, 'void'),
        ),
      )

    const linesByBooking = new Map<string, BillLine[]>()
    for (const r of foodRows) {
      if (!r.bookingId) continue
      const list = linesByBooking.get(r.bookingId) ?? []
      if (list.length === 0) linesByBooking.set(r.bookingId, list)
      list.push({
        description: r.itemName,
        kind: 'food',
        sourceId: r.itemId,
        qty: r.qty,
        unitPrice: Number(r.unitPrice),
        taxPercent: Number(r.taxRate),
      })
    }
    const liveInvoiceBookingIds = new Set(
      invoiceRows.map((r) => r.bookingId).filter((id): id is string => id !== null),
    )

    const out: Record<string, BookingBillingState> = {}
    for (const bookingId of bookingIds) {
      out[bookingId] = {
        runningTotal: priceBill({ lines: linesByBooking.get(bookingId) ?? [] }).total,
        hasLiveInvoice: liveInvoiceBookingIds.has(bookingId),
      }
    }
    return out
  })
}

export type RunningTab = {
  booking: {
    id: string
    bookingNumber: string
    status: string
    customerName: string | null
    customerPhone: string | null
    coverCount: number | null
    /** The table's resource name (M17), when this is a table session. Null
     *  for a timed booking — the running tab works for either. */
    tableName: string | null
    checkedInAt: string | null
  }
  lines: BillLine[]
  pricing: PricingResult
  /** Set once the booking already has a live (non-void) invoice — at that
   *  point loadBillLines legitimately returns nothing (its orders flipped to
   *  'billed'), so the page should point to the real invoice instead of
   *  showing an empty "tab". */
  existingInvoice: ExistingInvoice | null
  /** Lines whose stored tax rate no longer matches the menu — advisory. */
  taxDrift: TaxRateDrift[]
}

/**
 * The table/booking's CURRENT running tab (M17 #4) — everything still open,
 * priced live. Deliberately always loadBillLines(), never loadInvoiceLines():
 * this is the "what does it add up to right now" display a waiter pulls up
 * mid-meal, not the frozen invoice snapshot getBillableForBooking switches to
 * once one exists. Nothing here is written — no order ever flips to
 * 'billed', no invoice is ever created. Only issueInvoiceForBooking does that.
 */
export async function getRunningTab(ctx: ActiveContext, bookingId: string): Promise<RunningTab | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select({
        id: bookings.id,
        bookingNumber: bookings.bookingNumber,
        status: bookings.status,
        bookingCustomerName: bookings.customerName,
        bookingCustomerPhone: bookings.customerPhone,
        directoryName: customers.name,
        directoryPhone: customers.phone,
        coverCount: bookings.coverCount,
        checkedInAt: bookings.checkedInAt,
        tableName: resources.name,
      })
      .from(bookings)
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .leftJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenant.id)))
      .limit(1)
    if (!row) return null

    const lines = await loadBillLines(tx, ctx.tenant.id, row.id, ctx.tenant.timezone)
    const existingInvoice = await findLiveInvoice(tx, ctx.tenant.id, row.id)
    const taxDrift = existingInvoice ? [] : await loadTaxRateDrift(tx, ctx.tenant.id, row.id)

    return {
      booking: {
        id: row.id,
        bookingNumber: row.bookingNumber,
        status: row.status,
        customerName: row.directoryName ?? row.bookingCustomerName,
        customerPhone: row.directoryPhone ?? row.bookingCustomerPhone,
        coverCount: row.coverCount,
        tableName: row.tableName,
        checkedInAt: row.checkedInAt ? row.checkedInAt.toISOString() : null,
      },
      lines,
      pricing: priceBill({ lines }),
      existingInvoice,
      taxDrift,
    }
  })
}
