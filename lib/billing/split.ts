/**
 * Splitting an already-priced bill into several independently-payable checks
 * (M18 #2) — even N-way, by seat, or by item. NEVER re-prices a line: every
 * check is built by partitioning/apportioning the SAME PricingResult
 * issueInvoiceForBooking would have produced for the whole booking, using
 * groupByTaxRate/splitProportional (lib/billing/pricing.ts) — see those
 * functions' doc comments for the exactness guarantee. Each check becomes
 * its own `invoices` row, sharing one `bill_group_id` (migration 0089), and
 * is settled through the existing, unmodified payments flow
 * (recordPayment/payInvoiceFromWallet, PaymentPanel) — nothing there needs
 * to know a bill was ever split.
 *
 * v1 scope (confirmed): a split bill applies the booking's automatic
 * MEMBERSHIP discount only (resolved by prepareBookingBill, same as a normal
 * bill) — no promo code, no loyalty redemption, no online-deposit carry-over.
 * A cashier who needs those keys in a normal (unsplit) bill instead.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { invoices, invoiceItems, orders, orderItems } from '@/db/schema'
import { todayInZone } from '@/lib/booking/time'
import { cancelPendingOrdersForBilledBooking } from '@/lib/orders/service'
import { loadInvoicePrefix } from '@/lib/settings/business-profile'
import {
  BillingError,
  financialYearPeriod,
  nextInvoiceNumber,
  prepareBookingBill,
  writeAudit,
} from './invoice'
import {
  groupByTaxRate,
  mergeTaxBreakup,
  paise,
  round2,
  splitProportional,
  type PricedItem,
  type PricingResult,
  type ServiceChargeResult,
} from './pricing'

type Db = NodePgDatabase<typeof schema>

export type SplitMode = 'even' | 'seat' | 'item'

export type SplitInput =
  | { mode: 'even'; checkCount: number }
  | { mode: 'seat' }
  | { mode: 'item'; checkCount: number; assignments: Record<string, number> }

export type CheckLine = {
  kind: PricedItem['kind']
  sourceId: string | null
  description: string
  qty: number
  unitPrice: number
  taxPercent: number
  lineTotal: number
}

export type CheckPricing = {
  seq: number
  label: string
  subtotal: number
  discount: number
  taxableValue: number
  taxBreakup: { percent: number; cgst: number; sgst: number }[]
  taxTotal: number
  total: number
  items: CheckLine[]
  /** M18 #3 — this check's own proportional share of the whole bill's
   *  service charge (0 when the tenant has it off). Already folded into
   *  taxTotal/taxBreakup/total above; not a separate figure to add on top. */
  serviceChargePercent: number
  serviceChargeAmount: number
  serviceChargeTaxPercent: number
}

type Bucket = { seq: number; label: string; itemIndexes: number[] }

/**
 * Given a fixed group total and per-bucket weights, return one share per
 * bucket that (a) sums exactly to `total` (delegates to splitProportional
 * for that guarantee) and (b) gives a bucket with ZERO weight an EXACT zero
 * rather than a share of some other bucket's remainder — critical for
 * by-item/by-seat mode, where a check that ordered nothing at a given tax
 * rate must owe exactly nothing at that rate, never a rounding leftover.
 */
function splitSparse(total: number, weights: number[]): number[] {
  const activeIdx: number[] = []
  const activeWeights: number[] = []
  weights.forEach((w, i) => {
    if (w > 0) {
      activeIdx.push(i)
      activeWeights.push(w)
    }
  })
  const out = weights.map(() => 0)
  if (activeIdx.length === 0) return out
  const shares = splitProportional(total, activeWeights)
  activeIdx.forEach((idx, k) => {
    out[idx] = shares[k]
  })
  return out
}

/**
 * Resolve which check each priced item belongs to, and which items (if any)
 * are pooled as "shared" — divided evenly across every check present. Throws
 * BillingError with a cashier-safe message on any invalid split request.
 */
function resolveBuckets(
  pricing: PricingResult,
  seatByOrderItemId: Map<string, number | null>,
  input: SplitInput,
): { buckets: Bucket[]; sharedItemIndexes: number[] } {
  const items = pricing.items

  if (input.mode === 'even') {
    if (!Number.isInteger(input.checkCount) || input.checkCount < 2) {
      throw new BillingError('Choose at least 2 checks for an even split.')
    }
    const buckets = Array.from({ length: input.checkCount }, (_, i) => ({
      seq: i + 1,
      label: `Check ${i + 1} of ${input.checkCount}`,
      itemIndexes: [] as number[],
    }))
    // No item-level assignment at all — every item is pooled and divided
    // evenly across the checks below.
    return { buckets, sharedItemIndexes: items.map((_, i) => i) }
  }

  if (input.mode === 'seat') {
    const seatsPresent = new Set<number>()
    items.forEach((item) => {
      const seat = item.sourceId ? seatByOrderItemId.get(item.sourceId) : undefined
      if (seat != null) seatsPresent.add(seat)
    })
    const seatList = [...seatsPresent].sort((a, b) => a - b)
    if (seatList.length < 2) {
      throw new BillingError('Tag at least 2 seats before splitting by seat.')
    }
    const seatToBucketIndex = new Map(seatList.map((s, i) => [s, i]))
    const buckets = seatList.map((seat, i) => ({ seq: i + 1, label: `Seat ${seat}`, itemIndexes: [] as number[] }))
    const sharedItemIndexes: number[] = []
    items.forEach((item, idx) => {
      const seat = item.sourceId ? seatByOrderItemId.get(item.sourceId) : undefined
      const bucketIndex = seat != null ? seatToBucketIndex.get(seat) : undefined
      if (bucketIndex !== undefined) buckets[bucketIndex].itemIndexes.push(idx)
      else sharedItemIndexes.push(idx)
    })
    return { buckets, sharedItemIndexes }
  }

  // mode === 'item' — every line must be assigned to exactly one check.
  if (!Number.isInteger(input.checkCount) || input.checkCount < 2) {
    throw new BillingError('Choose at least 2 checks to split by item.')
  }
  const buckets = Array.from({ length: input.checkCount }, (_, i) => ({
    seq: i + 1,
    label: `Check ${i + 1} of ${input.checkCount}`,
    itemIndexes: [] as number[],
  }))
  items.forEach((item, idx) => {
    if (!item.sourceId) {
      throw new BillingError(`"${item.description}" cannot be assigned to a check.`)
    }
    const checkIndex = input.assignments[item.sourceId]
    if (checkIndex === undefined) {
      throw new BillingError(`"${item.description}" was not assigned to a check.`)
    }
    if (!Number.isInteger(checkIndex) || checkIndex < 0 || checkIndex >= input.checkCount) {
      throw new BillingError(`"${item.description}" was assigned to an unknown check.`)
    }
    buckets[checkIndex].itemIndexes.push(idx)
  })
  const emptyCheck = buckets.find((b) => b.itemIndexes.length === 0)
  if (emptyCheck) throw new BillingError(`${emptyCheck.label} has no items assigned.`)
  return { buckets, sharedItemIndexes: [] }
}

/**
 * The pure split math — computes every check's full pricing breakdown from
 * an already-computed PricingResult. Shared by the preview (read-only) and
 * the actual issuer below, so a preview can never show a different number
 * than what gets billed.
 *
 * ── Exactness, by construction ──────────────────────────────────────────
 * For each original tax-rate group g (from groupByTaxRate, the SAME grouping
 * priceBill itself used):
 *   1. Each check's REAL assigned items at rate g sum EXACTLY (they are a
 *      true partition of already-rounded lineTotals — plain integer-paise
 *      addition, no rounding needed).
 *   2. Whatever of g's subtotal is NOT claimed by any check's real items
 *      (the "shared" pool — every item for an even split, or only the
 *      unseated/unassigned items for a by-seat split) is divided EQUALLY
 *      across every check via splitProportional — exact, remainder
 *      deterministically on the last check.
 *   3. Each check's TOTAL group-g subtotal (real + its equal shared share)
 *      is therefore exact and non-negative by construction. g's discount and
 *      g's tax are then apportioned across checks proportional to THOSE
 *      subtotal shares (splitSparse) — exact, and a check with zero
 *      group-g subtotal gets exactly zero discount/tax for that rate, never
 *      a stray remainder.
 * Summing (1)+(2) reproduces g.subtotal exactly; the discount/tax
 * allocations in (3) reproduce g.discount/g.tax exactly (same telescoping
 * guarantee as splitProportional). So every check's subtotal, discount, tax
 * and total sum EXACTLY to the whole bill's — for every tax rate, and in
 * aggregate — with no line ever re-priced.
 */
export function computeSplitChecks(
  pricing: PricingResult,
  seatByOrderItemId: Map<string, number | null>,
  input: SplitInput,
): CheckPricing[] {
  const { buckets, sharedItemIndexes } = resolveBuckets(pricing, seatByOrderItemId, input)
  const items = pricing.items
  const groups = groupByTaxRate(items, pricing.discount)
  const groupIndexByPercent = new Map(groups.map((g, i) => [g.percent, i]))

  // assignedSubtotal[bucketIdx][groupIdx] — exact partition, no rounding.
  const assignedSubtotal: number[][] = buckets.map(() => groups.map(() => 0))
  buckets.forEach((b, bIdx) => {
    for (const idx of b.itemIndexes) {
      const item = items[idx]
      const gIdx = groupIndexByPercent.get(item.taxPercent)!
      assignedSubtotal[bIdx][gIdx] = round2(assignedSubtotal[bIdx][gIdx] + item.lineTotal)
    }
  })

  // sharedSubtotal[groupIdx] — the pool this rate group has left unclaimed.
  const sharedSubtotal: number[] = groups.map(() => 0)
  for (const idx of sharedItemIndexes) {
    const item = items[idx]
    const gIdx = groupIndexByPercent.get(item.taxPercent)!
    sharedSubtotal[gIdx] = round2(sharedSubtotal[gIdx] + item.lineTotal)
  }

  // Per check, per group: totals + the invoice_items to write.
  const checkGroupTotals: { subtotal: number; discount: number; tax: number; cgst: number; sgst: number }[][] =
    buckets.map(() => groups.map(() => ({ subtotal: 0, discount: 0, tax: 0, cgst: 0, sgst: 0 })))
  const checkExtraLines: CheckLine[][] = buckets.map(() => [])

  groups.forEach((g, gIdx) => {
    // Shared pool for this rate, divided EQUALLY across every check present —
    // "shared/unassigned items divided evenly" (an even split pools EVERY
    // item, so this is its entire mechanism; by-seat only pools the
    // unassigned leftover).
    const equalWeights = buckets.map(() => 1)
    const sharedShares = splitProportional(sharedSubtotal[gIdx], equalWeights)

    const bucketGroupSubtotal = buckets.map((_, bIdx) => round2(assignedSubtotal[bIdx][gIdx] + sharedShares[bIdx]))
    const discountShares = splitSparse(g.discount, bucketGroupSubtotal)
    const taxShares = splitSparse(g.tax, bucketGroupSubtotal)

    buckets.forEach((b, bIdx) => {
      const tax = taxShares[bIdx]
      // Rounded ONCE; sgst takes the remainder, so cgst + sgst === tax
      // exactly even for an odd paisa (e.g. tax 0.01 must not become 0.02).
      const cgst = round2(tax / 2)
      const sgst = round2(tax - cgst)
      checkGroupTotals[bIdx][gIdx] = {
        subtotal: bucketGroupSubtotal[bIdx],
        discount: discountShares[bIdx],
        tax,
        cgst,
        sgst,
      }
      if (paise(sharedShares[bIdx]) !== 0) {
        checkExtraLines[bIdx].push({
          kind: 'adjustment',
          sourceId: null,
          description:
            input.mode === 'even'
              ? `Split share — ${g.percent}% GST items`
              : `Shared items — ${g.percent}% GST`,
          qty: 1,
          unitPrice: sharedShares[bIdx],
          taxPercent: g.percent,
          lineTotal: sharedShares[bIdx],
        })
      }
    })
  })

  return buckets.map((b, bIdx) => {
    const realItems: CheckLine[] = b.itemIndexes.map((idx) => {
      const item = items[idx]
      return {
        kind: item.kind,
        sourceId: item.sourceId ?? null,
        description: item.description,
        qty: item.qty,
        unitPrice: item.unitPrice,
        taxPercent: item.taxPercent,
        lineTotal: item.lineTotal,
      }
    })
    const groupTotals = checkGroupTotals[bIdx]
    const subtotal = round2(groupTotals.reduce((s, g) => s + g.subtotal, 0))
    const discount = round2(groupTotals.reduce((s, g) => s + g.discount, 0))
    const taxTotal = round2(groupTotals.reduce((s, g) => s + g.tax, 0))
    const taxableValue = round2(subtotal - discount)
    const total = round2(taxableValue + taxTotal)
    const taxBreakup = groups
      .map((g, gIdx) => ({ percent: g.percent, cgst: groupTotals[gIdx].cgst, sgst: groupTotals[gIdx].sgst }))
      .filter((g) => paise(g.cgst) !== 0 || paise(g.sgst) !== 0)

    return {
      seq: b.seq,
      label: b.label,
      subtotal,
      discount,
      taxableValue,
      taxBreakup,
      taxTotal,
      total,
      items: [...realItems, ...checkExtraLines[bIdx]],
      // Service charge (M18 #3) is applied afterward by
      // applyServiceChargeToChecks — computeSplitChecks itself stays
      // food-only, zero risk to this already-tested math.
      serviceChargePercent: 0,
      serviceChargeAmount: 0,
      serviceChargeTaxPercent: 0,
    }
  })
}

/**
 * Apportion the whole bill's service charge (M18 #3) across already-split
 * checks, proportional to each check's own (already-exact) food subtotal —
 * "each check pays service charge on what it actually ordered", not an
 * even split. Reuses splitProportional, so `sum(check.serviceChargeAmount)
 * === serviceCharge.amount` and `sum(check.serviceChargeTaxAmount) ===
 * serviceCharge.tax` exactly, by the same construction computeSplitChecks
 * itself relies on. A no-op when service charge is off (amount 0).
 *
 * Deliberately NOT folded into computeSplitChecks/resolveBuckets: service
 * charge has no item to assign or share evenly — it is derived FROM each
 * check's own subtotal after splitting, not distributed WITH the food.
 */
function applyServiceChargeToChecks(checks: CheckPricing[], serviceCharge: ServiceChargeResult): CheckPricing[] {
  if (paise(serviceCharge.amount) <= 0) return checks

  const weights = checks.map((c) => c.subtotal)
  const amountShares = splitProportional(serviceCharge.amount, weights)
  const taxShares = splitProportional(serviceCharge.tax, weights)

  return checks.map((check, i) => {
    const amount = amountShares[i]
    const tax = taxShares[i]
    const taxTotal = round2(check.taxTotal + tax)
    // Rounded ONCE; sgst takes the remainder, so cgst + sgst === tax exactly
    // even for an odd paisa.
    const scCgst = round2(tax / 2)
    const scSgst = round2(tax - scCgst)
    const taxBreakup = mergeTaxBreakup(check.taxBreakup, {
      percent: serviceCharge.taxPercent,
      cgst: scCgst,
      sgst: scSgst,
    })
    const total = round2(check.taxableValue + amount + taxTotal)
    const items = [...check.items]
    if (paise(amount) > 0) {
      items.push({
        kind: 'service_charge',
        sourceId: null,
        description: `Service charge (${serviceCharge.percent}%) — ${check.label}`,
        qty: 1,
        unitPrice: amount,
        taxPercent: serviceCharge.taxPercent,
        lineTotal: amount,
      })
    }
    return {
      ...check,
      taxTotal,
      taxBreakup,
      total,
      items,
      serviceChargePercent: serviceCharge.percent,
      serviceChargeAmount: amount,
      serviceChargeTaxPercent: serviceCharge.taxPercent,
    }
  })
}

/** order_items.id → seatNo (or null), for every food line a booking's bill
 *  may draw from — the same rows prepareBookingBill's `lines` came from,
 *  re-read here because BillLine (and therefore PricingResult.items) does
 *  not itself carry seatNo (M18 #1's seat tag is bookkeeping, deliberately
 *  outside the pricing engine). */
export async function loadSeatByOrderItemId(tx: Db, tenantId: string, bookingId: string): Promise<Map<string, number | null>> {
  const rows = await tx
    .select({ id: orderItems.id, seatNo: orderItems.seatNo })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.tenantId, tenantId), eq(orders.bookingId, bookingId)))
  return new Map(rows.map((r) => [r.id, r.seatNo]))
}

export type IssueSplitBillInput = {
  bookingId: string
  /** Bill-level comp/discount (M18 #5) — see lib/billing/invoice.ts's
   *  IssueInvoiceInput.comp for the trust model (already gated by the caller,
   *  re-validated/re-capped here). Applied BEFORE splitting, same as the
   *  membership discount, and apportioned pro-rata across every check
   *  (v1 scope — see this module's header). */
  comp?: { amount: number; reason: string; membershipId: string }
} & SplitInput

export type IssuedCheck = { invoiceId: string; invoiceNumber: string; seq: number; label: string; pricing: CheckPricing }

export type IssuedSplitBill = { billGroupId: string; checks: IssuedCheck[] }

/**
 * Raise a split bill for a booking — N invoices sharing one bill_group_id,
 * each independently payable. Mirrors issueInvoiceForBooking's structure
 * (prepareBookingBill for the shared preamble, same number/order-status
 * machinery) but writes N invoice rows instead of one, priced by
 * computeSplitChecks above instead of a second priceBill() call.
 */
export async function issueSplitBillForBooking(
  tx: Db,
  tenant: { id: string; timezone: string },
  input: IssueSplitBillInput,
): Promise<IssuedSplitBill> {
  const { booking, billedOrderIds, gross, membership, membershipDiscount, serviceCharge } = await prepareBookingBill(
    tx,
    tenant,
    input.bookingId,
  )

  // Bill-level comp (M18 #5) — LAST in precedence, same as the unsplit path
  // (lib/billing/invoice.ts): applied on top of membership, capped at what
  // remains. Authorization already happened in the caller
  // (lib/actions/billing.ts); this only re-validates the reason and re-caps.
  const afterMembership = round2(gross.subtotal - membershipDiscount)
  let compAmount = 0
  let compReason: string | null = null
  if (input.comp && input.comp.amount > 0) {
    if (!input.comp.reason || input.comp.reason.trim() === '') {
      throw new BillingError('A reason is required to comp or discount a bill.')
    }
    compAmount = Math.min(round2(input.comp.amount), Math.max(0, afterMembership))
    compReason = input.comp.reason.trim()
  }

  // v1 scope: membership + comp only (see module header) — no promo/loyalty
  // input for a split bill.
  const pricing = priceWithDiscount(gross, round2(membershipDiscount + compAmount))

  const seatByOrderItemId =
    input.mode === 'seat' ? await loadSeatByOrderItemId(tx, tenant.id, booking.id) : new Map<string, number | null>()

  const checks = applyServiceChargeToChecks(computeSplitChecks(pricing, seatByOrderItemId, input), serviceCharge)

  // Attribute each check's OWN share of the combined discount to membership
  // vs. comp, for the frozen columns below. Only bother when a comp was
  // actually requested: when it wasn't (the overwhelming common case),
  // membershipShares must equal check.discount EXACTLY, unchanged from
  // before this feature existed — no test covers the exact paisa this
  // column carries per check, so this is deliberately zero-risk rather than
  // "probably still right".
  //
  // When a comp WAS requested: membershipShares sums exactly to
  // membershipDiscount (splitProportional's own guarantee), and each
  // check's compShare is simply what its total discount has left over, so
  // membershipShare + compShare === check.discount for every check, and
  // compShares sums exactly to compAmount in aggregate. Clamped at zero:
  // membershipShares is a single flat proportional split by check.subtotal,
  // while check.discount comes from a nested per-tax-rate-group split
  // (computeSplitChecks) that can place a stray paisa's remainder on a
  // different check when there is more than one GST rate — without the
  // clamp that could theoretically show as a hairline negative comp share,
  // which the invoices_comp_amount_check constraint would reject outright.
  // Harmless either way: this is a descriptive attribution only,
  // check.discount/total (the actual money) are unaffected either way.
  const membershipShares =
    compAmount > 0
      ? splitProportional(
          membershipDiscount,
          checks.map((c) => c.subtotal),
        )
      : checks.map((c) => c.discount)
  const compShares =
    compAmount > 0 ? checks.map((c, i) => Math.max(0, round2(c.discount - membershipShares[i]))) : checks.map(() => 0)

  const period = financialYearPeriod(todayInZone(tenant.timezone))
  const prefix = await loadInvoicePrefix(tx, tenant.id)
  const billGroupId = randomUUID()

  const issued: IssuedCheck[] = []
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]
    const invoiceNumber = await nextInvoiceNumber(tx, tenant.id, period, prefix)
    const settledOnIssue = paise(check.total) === 0

    const [invoice] = await tx
      .insert(invoices)
      .values({
        tenantId: tenant.id,
        branchId: booking.branchId,
        invoiceNumber,
        bookingId: booking.id,
        customerId: booking.customerId,
        // Descriptive fields (not additive money) — membershipShares/
        // compShares split check.discount's money between the two causes
        // (see the comment above where they're computed); membershipDiscount
        // + compAmount === check.discount for every check, exactly.
        customerMembershipId: membership?.membershipId ?? null,
        membershipDiscount: membershipShares[i].toFixed(2),
        membershipDiscountPercent: (membership?.discountPercent ?? 0).toFixed(2),
        membershipPlanName: membership?.planName ?? null,
        subtotal: check.subtotal.toFixed(2),
        discount: check.discount.toFixed(2),
        taxTotal: check.taxTotal.toFixed(2),
        taxBreakup: check.taxBreakup.map((g) => ({ rate: g.percent, cgst: g.cgst.toFixed(2), sgst: g.sgst.toFixed(2) })),
        total: check.total.toFixed(2),
        status: settledOnIssue ? 'paid' : 'issued',
        issuedAt: new Date(),
        billGroupId,
        billGroupSeq: check.seq,
        // This check's own proportional share (M18 #3) — see
        // applyServiceChargeToChecks for how it's apportioned.
        serviceChargePercent: check.serviceChargePercent.toFixed(2),
        serviceChargeAmount: check.serviceChargeAmount.toFixed(2),
        serviceChargeTaxPercent: check.serviceChargeTaxPercent.toFixed(2),
        // Bill-level comp (M18 #5) — this check's own share; see
        // audit_log write below for the durable who/why record.
        compAmount: compShares[i].toFixed(2),
        compReason: compShares[i] > 0 ? compReason : null,
        compedByMembershipId: compShares[i] > 0 ? (input.comp?.membershipId ?? null) : null,
      })
      .returning({ id: invoices.id })

    if (compShares[i] > 0 && input.comp) {
      await writeAudit(tx, { tenantId: tenant.id, membershipId: input.comp.membershipId }, {
        action: 'invoice.comp',
        entityType: 'invoice',
        entityId: invoice.id,
        before: { invoice_number: invoiceNumber, subtotal: check.subtotal.toFixed(2), bill_group_id: billGroupId },
        after: {
          invoice_number: invoiceNumber,
          amount: compShares[i].toFixed(2),
          reason: compReason,
          booking_id: booking.id,
          bill_group_id: billGroupId,
        },
      })
    }

    await tx.insert(invoiceItems).values(
      check.items.map((item) => ({
        tenantId: tenant.id,
        invoiceId: invoice.id,
        kind: item.kind,
        sourceId: item.sourceId,
        description: item.description,
        qty: item.qty.toFixed(2),
        unitPrice: item.unitPrice.toFixed(2),
        taxRate: item.taxPercent.toFixed(2),
        lineTotal: item.lineTotal.toFixed(2),
      })),
    )

    issued.push({ invoiceId: invoice.id, invoiceNumber, seq: check.seq, label: check.label, pricing: check })
  }

  // Same double-sided double-billing guard as issueInvoiceForBooking's steps
  // 7/7b — run ONCE for the whole split, not per check: every check draws
  // from the SAME captured billedOrderIds set.
  if (billedOrderIds.length > 0) {
    await tx
      .update(orders)
      .set({ status: 'billed' })
      .where(
        and(
          eq(orders.tenantId, tenant.id),
          eq(orders.bookingId, booking.id),
          eq(orders.status, 'open'),
          eq(orders.acceptanceStatus, 'accepted'),
          inArray(orders.id, billedOrderIds),
        ),
      )
  }
  await cancelPendingOrdersForBilledBooking(tx, { tenantId: tenant.id }, booking.id)

  return { billGroupId, checks: issued }
}

/** priceWithDiscount re-derives taxableValue/taxBreakup/taxTotal/total for
 *  `gross` (priced with NO discount) at the given discount, via the exact
 *  same groupByTaxRate machinery priceBill itself uses — equivalent to
 *  calling priceBill({lines, discount}) again, without re-pricing a single
 *  line (items/subtotal are reused verbatim from `gross`). */
function priceWithDiscount(gross: PricingResult, discount: number): PricingResult {
  const cappedDiscount = Math.min(round2(discount), gross.subtotal)
  const taxableValue = round2(gross.subtotal - cappedDiscount)
  const groups = groupByTaxRate(gross.items, cappedDiscount)
  const taxBreakup = groups.map((g) => ({ percent: g.percent, cgst: g.cgst, sgst: g.sgst }))
  const taxTotal = round2(groups.reduce((sum, g) => sum + g.tax, 0))
  const total = round2(taxableValue + taxTotal)
  return { ...gross, discount: cappedDiscount, taxableValue, taxBreakup, taxTotal, total }
}

/**
 * Read-only preview of what a split would produce, for the UI to show before
 * committing. Uses the SAME computeSplitChecks/applyServiceChargeToChecks
 * the real issuer calls, so the preview can never diverge from what
 * actually gets billed.
 */
export function previewSplitChecks(
  gross: PricingResult,
  membershipDiscount: number,
  serviceCharge: ServiceChargeResult,
  seatByOrderItemId: Map<string, number | null>,
  input: SplitInput,
  /** Bill-level comp (M18 #5) preview, already capped by the caller against
   *  what remains after membership — see issueSplitBillForBooking's own
   *  computation, mirrored here read-only. 0 when no comp is being tried. */
  compAmount = 0,
): CheckPricing[] {
  const pricing = priceWithDiscount(gross, round2(membershipDiscount + compAmount))
  return applyServiceChargeToChecks(computeSplitChecks(pricing, seatByOrderItemId, input), serviceCharge)
}
