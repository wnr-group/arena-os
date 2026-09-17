import 'server-only'
import { and, asc, eq, inArray, max, min, ne } from 'drizzle-orm'
import { withUser } from '@/db'
import { bookings, bookingSlots, branches, customers, invoices, memberships, orderItems, orders, resources } from '@/db/schema'
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
import { getInvoiceSettlement, type InvoiceSettlement } from './payments'
import { walletTenderState } from './wallet-payments'
import { loadInvoiceReceipt, type InvoiceReceipt } from './receipt'
import { priceBill, type BillLine, type PricingResult, type ServiceChargeConfig } from './pricing'
import { loadServiceChargeConfig } from '@/lib/settings/business-profile'

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
   * Every check of a split bill (M18 #2), ordered by bill_group_seq — null
   * for a booking that was never split. Mutually exclusive with
   * `existingInvoice`/`settlement`: a booking is either unbilled, billed as
   * one invoice, or split into N checks, never more than one of the three.
   */
  splitChecks: CheckView[] | null
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
      splitChecks,
      membership,
      wallet,
      loyalty,
      serviceChargeConfig,
      staff,
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
    }
  })
}
