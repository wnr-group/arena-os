import 'server-only'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { platformInvoices, platformRefunds } from '@/db/schema'
import { paise, round2 } from '@/lib/billing/pricing'
import { RazorpayApiError } from '@/lib/payments/razorpay'
import { pgError } from '@/lib/utils/errors'
import {
  requirePlatformRazorpayCredentials,
  type PlatformRazorpayCredentials,
} from './credentials'
import { refundRazorpayPayment, type RefundPaymentFn } from './razorpay-subscriptions'
import { GATEWAY } from './lifecycle'
import { recordPlatformOverride, type PlatformActor } from './audit'

/**
 * REFUNDING A PLATFORM SUBSCRIPTION CHARGE (AROS-114 §8).
 *
 * Arena OS giving a business back part or all of what it paid for its
 * subscription. NOT lib/billing/refunds.ts, which is a VENUE refunding its own
 * customer out of its own till — different money, different direction,
 * different Razorpay account (0080), different parent table.
 *
 * ═══ THE ORDERING, AND WHY IT IS THIS WAY ═══════════════════════════════════
 *
 * Three phases, and the split is the whole safety argument:
 *
 *   1. RESERVE (one transaction). Lock the invoice, check the cap, and INSERT
 *      the refund row as `status = 'pending'`. Commit.
 *   2. INSTRUCT (no transaction, no locks). Call Razorpay.
 *   3. SETTLE (one transaction). Record what Razorpay said.
 *
 * A pending row COUNTS against the invoice's refundable balance, so the
 * reservation in (1) is what makes concurrent refunds safe: two admins clicking
 * at once serialise on the invoice's row lock, and the second one sees the
 * first one's pending amount already deducted. Doing the cap check and the
 * gateway call in one transaction instead would pin a row lock for the length
 * of an HTTP timeout; doing the gateway call FIRST would mean a network failure
 * could leave money refunded with no local record of it at all.
 *
 * ── What happens when (2) fails ─────────────────────────────────────────────
 *
 * It depends on WHETHER THE REFUND MIGHT HAVE HAPPENED, and this distinction is
 * load-bearing:
 *
 *   a 4xx (non-retriable)   Razorpay refused outright. The row is marked
 *                           'failed', which RELEASES the reserved amount back
 *                           to the invoice's refundable balance.
 *   a timeout or 5xx        UNKNOWN. The refund may well have been created. The
 *                           row STAYS 'pending' — the reservation is kept, so
 *                           the amount cannot be refunded twice — and the
 *                           webhook settles it. Marking it failed here would
 *                           release a cap against money that may already be
 *                           gone, which is the one mistake that cannot be
 *                           undone.
 *
 * That second row has NO `gateway_refund_id`: we never saw the response that
 * carries it. The webhook therefore cannot recognise it by reference, and for a
 * while it did not recognise it at all — the row stayed pending forever, its
 * slice of the invoice permanently unrefundable and the money it represented
 * missing from the revenue series. applyVerifiedRefundEvent() below now ADOPTS
 * such a row by the payment it came from; the rules it applies to avoid
 * adopting the wrong one are stated there.
 *
 * ═══ THE GATEWAY IS AUTHORITATIVE ═══════════════════════════════════════════
 *
 * A row reaches 'processed' only because Razorpay said so — either in the
 * response to (2), or in a signature-verified `refund.processed` webhook. The
 * browser round-trip that started the refund proves nothing, exactly as it
 * proves nothing for a subscription (see the platform webhook route's header).
 * Only 'processed' is counted as refunded revenue by the dashboard.
 *
 * ═══ IDEMPOTENCY, AT THREE LEVELS ═══════════════════════════════════════════
 *
 *   1. `request_key` — the caller's retry token, unique per tenant (0083),
 *      the same idiom payments.idempotency_key (0040) uses. A double-clicked
 *      button sends the same key, the second insert is refused, and the FIRST
 *      refund is returned. This is what the invoice cap alone cannot do: two
 *      identical ₹500 refunds against a ₹8,000 invoice are both within the cap
 *      and both wrong.
 *   2. `X-Razorpay-Idempotency-Key` — our refund row's id, sent to Razorpay, so
 *      a retried instruction returns the SAME refund object rather than
 *      creating a second one at the gateway.
 *   3. `idx_platform_refunds_gateway_ref` — one row per Razorpay refund id, so
 *      a redelivered webhook cannot double-count money that came back once.
 */

/** A refund rule the admin should see verbatim. */
export class PlatformRefundError extends Error {}

/** Statuses that RESERVE part of an invoice's refundable balance. */
const RESERVING_STATUSES = ['pending', 'processed'] as const

export type PlatformRefundRow = {
  id: string
  tenantId: string
  invoiceId: string
  amount: number
  currency: string
  reason: string
  status: 'pending' | 'processed' | 'failed'
  gatewayRefundId: string | null
  createdAt: Date
}

export type RefundableInvoice = {
  invoiceId: string
  invoiceNumber: string
  tenantId: string
  total: number
  /** Already refunded or reserved — pending AND processed. */
  refunded: number
  /** total − refunded. What a new refund may not exceed. */
  refundable: number
  currency: string
  gatewayPaymentId: string | null
  refundable_reason?: string
}

/**
 * How much of one invoice may still come back.
 *
 * Sums the rows rather than reading a stored balance — the same discipline
 * lib/billing/refunds.ts follows, and the structural reason nothing in this
 * schema can double-count money: there is no accumulated total for a replay to
 * add to.
 */
export async function refundedForInvoice(tx: DB, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${platformRefunds.amount}), 0)` })
    .from(platformRefunds)
    .where(
      and(
        eq(platformRefunds.invoiceId, invoiceId),
        inArray(platformRefunds.status, [...RESERVING_STATUSES]),
      ),
    )
  return round2(Number(row?.total ?? 0))
}

/** Every refund against one invoice, newest first. Platform-admin surface. */
export async function listRefundsForTenant(
  tx: DB,
  tenantId: string,
  limit = 50,
): Promise<PlatformRefundRow[]> {
  const rows = await tx
    .select({
      id: platformRefunds.id,
      tenantId: platformRefunds.tenantId,
      invoiceId: platformRefunds.invoiceId,
      amount: platformRefunds.amount,
      currency: platformRefunds.currency,
      reason: platformRefunds.reason,
      status: platformRefunds.status,
      gatewayRefundId: platformRefunds.gatewayRefundId,
      createdAt: platformRefunds.createdAt,
    })
    .from(platformRefunds)
    .where(eq(platformRefunds.tenantId, tenantId))
    .orderBy(sql`${platformRefunds.createdAt} desc`)
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    amount: round2(Number(r.amount)),
    status: r.status as PlatformRefundRow['status'],
  }))
}

export type RefundGateway = {
  refundPayment: RefundPaymentFn
  credentials?: () => Promise<PlatformRazorpayCredentials>
}

const DEFAULT_GATEWAY: RefundGateway = { refundPayment: refundRazorpayPayment }

export type RefundPlatformInvoiceParams = {
  invoiceId: string
  /** RUPEES. Validated against the invoice under a lock; never trusted as-is. */
  amount: number
  reason: string
  /** The caller's retry token. Strongly recommended; see idempotency above. */
  requestKey?: string | null
}

export type RefundOutcome = {
  refundId: string
  amount: number
  status: 'pending' | 'processed' | 'failed'
  gatewayRefundId: string | null
  /** True when this call found an existing refund for the same request key. */
  deduplicated: boolean
  /** Set when the gateway outcome is not yet known. */
  note?: string
}

/**
 * Refund part or all of one paid platform invoice.
 *
 * `tenantId` is NEVER taken from a caller — it is read from the locked invoice
 * row, so there is no shape of call that books a refund against the wrong
 * business. The amount is likewise validated against that row rather than
 * believed.
 */
export async function refundPlatformInvoice(
  actor: PlatformActor,
  params: RefundPlatformInvoiceParams,
  gateway: RefundGateway = DEFAULT_GATEWAY,
  db: DB = ownerDb,
): Promise<RefundOutcome> {
  const reason = params.reason.trim()
  if (!reason) throw new PlatformRefundError('A reason is required.')
  if (reason.length > 500) throw new PlatformRefundError('That reason is too long (max 500).')

  const requestKey = params.requestKey?.trim() || null

  // ── phase 1: reserve ──────────────────────────────────────────────────────
  const reserved = await db.transaction(async (tx) => {
    // THE LOCK. Everything below reads a row nothing else can change until this
    // transaction commits, which is what makes the cap check atomic.
    const [invoice] = await tx
      .select({
        id: platformInvoices.id,
        tenantId: platformInvoices.tenantId,
        subscriptionId: platformInvoices.subscriptionId,
        invoiceNumber: platformInvoices.invoiceNumber,
        kind: platformInvoices.kind,
        status: platformInvoices.status,
        total: platformInvoices.total,
        currency: platformInvoices.currency,
        gateway: platformInvoices.gateway,
        gatewayPaymentId: platformInvoices.gatewayPaymentId,
      })
      .from(platformInvoices)
      .where(eq(platformInvoices.id, params.invoiceId))
      .for('update')
      .limit(1)

    if (!invoice) throw new PlatformRefundError('Invoice not found.')

    // A credit note is not money that moved — `platform_invoices_credit_note_
    // unpaid` (0081) guarantees it carries no payment — so there is nothing to
    // give back.
    if (invoice.kind !== 'subscription') {
      throw new PlatformRefundError('Only a subscription invoice can be refunded.')
    }
    if (invoice.status !== 'paid') {
      throw new PlatformRefundError('Only a paid invoice can be refunded.')
    }
    if (!invoice.gatewayPaymentId || invoice.gateway !== GATEWAY) {
      // No captured Razorpay payment behind it. Refunding would mean sending
      // money with no record of where it came from.
      throw new PlatformRefundError(
        'This invoice has no gateway payment to refund. Issue a credit note instead.',
      )
    }

    // ── the double-click guard ────────────────────────────────────────────
    //
    // An earlier attempt with the same token. Returned unchanged rather than
    // repeated, and checked BEFORE the cap so a retry cannot be refused for
    // exhausting a balance its own first attempt consumed.
    //
    // Scoped by TENANT, matching idx_platform_refunds_request exactly. The
    // tenant comes from the locked invoice above, never from the caller — a
    // lookup on the token alone could match a different business's refund and
    // silently answer with its details instead of doing the work.
    if (requestKey) {
      const [existing] = await tx
        .select({
          id: platformRefunds.id,
          amount: platformRefunds.amount,
          status: platformRefunds.status,
          gatewayRefundId: platformRefunds.gatewayRefundId,
        })
        .from(platformRefunds)
        .where(
          and(
            eq(platformRefunds.tenantId, invoice.tenantId),
            eq(platformRefunds.requestKey, requestKey),
          ),
        )
        .limit(1)
      if (existing) {
        return {
          duplicate: true as const,
          id: existing.id,
          amount: round2(Number(existing.amount)),
          status: existing.status as RefundOutcome['status'],
          gatewayRefundId: existing.gatewayRefundId,
        }
      }
    }

    const total = round2(Number(invoice.total))
    const alreadyRefunded = await refundedForInvoice(tx, invoice.id)
    const refundable = round2(total - alreadyRefunded)

    if (paise(refundable) <= 0) {
      throw new PlatformRefundError('This invoice has already been fully refunded.')
    }

    const amount = round2(params.amount)
    if (!Number.isFinite(amount) || paise(amount) <= 0) {
      throw new PlatformRefundError('Enter a refund amount greater than zero.')
    }
    // Compared in PAISE, never in rupees, and NOT silently trimmed to the
    // remainder — the admin re-enters an explicit figure, exactly as
    // lib/billing/refunds.ts requires of a manager.
    if (paise(alreadyRefunded) + paise(amount) > paise(total)) {
      throw new PlatformRefundError(
        `Refund exceeds the refundable amount. ${refundable.toFixed(2)} remains on ${invoice.invoiceNumber}.`,
      )
    }

    let row: { id: string } | undefined
    try {
      ;[row] = await tx
        .insert(platformRefunds)
        .values({
          // From the LOCKED INVOICE, never from the caller.
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          gateway: GATEWAY,
          gatewayPaymentId: invoice.gatewayPaymentId,
          amount: amount.toFixed(2),
          currency: invoice.currency,
          reason,
          status: 'pending',
          createdByUserId: actor.userId,
          requestKey,
        })
        .returning({ id: platformRefunds.id })
    } catch (e) {
      // idx_platform_refunds_request: a concurrent attempt with the same token
      // won the race. Its refund is the one that stands.
      if (pgError(e).code === '23505') {
        throw new PlatformRefundError('That refund is already being processed.')
      }
      throw e
    }

    // The audit entry is written HERE, with the reservation, in the same
    // transaction — so a refund can never exist without a record of who asked
    // for it, even if the gateway call later fails. Phase 3 does not write a
    // second entry; it updates the row the entry points at.
    await recordPlatformOverride(tx, actor, {
      tenantId: invoice.tenantId,
      action: 'refund',
      entityType: 'platform_invoice',
      entityId: invoice.id,
      before: {
        invoiceNumber: invoice.invoiceNumber,
        total,
        refundedBefore: alreadyRefunded,
        refundableBefore: refundable,
      },
      after: {
        refundId: row!.id,
        amount,
        currency: invoice.currency,
        reason,
        status: 'pending',
        refundedAfter: round2(alreadyRefunded + amount),
      },
    })

    return {
      duplicate: false as const,
      id: row!.id,
      amount,
      currency: invoice.currency,
      gatewayPaymentId: invoice.gatewayPaymentId,
      tenantId: invoice.tenantId,
    }
  })

  if (reserved.duplicate) {
    return {
      refundId: reserved.id,
      amount: reserved.amount,
      status: reserved.status,
      gatewayRefundId: reserved.gatewayRefundId,
      deduplicated: true,
    }
  }

  // ── phase 2: instruct the gateway ─────────────────────────────────────────
  //
  // Outside any transaction, so no row lock is held across an HTTP timeout.
  const credentials = await (gateway.credentials
    ? gateway.credentials()
    : requirePlatformRazorpayCredentials())

  let gatewayRefund: Awaited<ReturnType<RefundPaymentFn>>
  try {
    gatewayRefund = await gateway.refundPayment(credentials, {
      paymentId: reserved.gatewayPaymentId,
      // Rupees → paise, converted once, here. The gateway client does no
      // arithmetic at all (see its header), so this is the only place the
      // conversion happens on this path.
      amountPaise: paise(reserved.amount),
      // OUR refund id as the gateway's idempotency key: a retried instruction
      // returns the same refund object instead of creating a second one.
      idempotencyKey: reserved.id,
      notes: { arena_tenant_id: reserved.tenantId, arena_refund_id: reserved.id },
    })
  } catch (e) {
    const refused = e instanceof RazorpayApiError && !e.retriable

    if (refused) {
      // Definitely refused. Release the reservation so the amount is refundable
      // again, and say what happened.
      await db
        .update(platformRefunds)
        .set({ status: 'failed', reason: `${reason} [gateway refused]`.slice(0, 500) })
        .where(eq(platformRefunds.id, reserved.id))
      throw new PlatformRefundError(
        e instanceof Error ? e.message : 'The payment gateway refused the refund.',
      )
    }

    // UNKNOWN. The row stays 'pending' and keeps its reservation — see the
    // header. The webhook will settle it, or an operator will reconcile it.
    return {
      refundId: reserved.id,
      amount: reserved.amount,
      status: 'pending',
      gatewayRefundId: null,
      deduplicated: false,
      note:
        'The gateway did not confirm in time. The refund is recorded as pending and will settle when Razorpay confirms it — do not retry.',
    }
  }

  // ── phase 3: settle ───────────────────────────────────────────────────────
  const status = normaliseRefundStatus(gatewayRefund.status)
  await db
    .update(platformRefunds)
    .set({
      gatewayRefundId: gatewayRefund.id,
      status,
      // Stamped only on the way to 'processed', and only if it is not already
      // stamped: `coalesce` makes this SET-ONCE even in the race where a
      // `refund.processed` webhook lands before this response returns. The
      // revenue series buckets on this column (0085), and a figure a month has
      // already been reported on must not move because a duplicate settle
      // arrived seconds later.
      ...(status === 'processed'
        ? { processedAt: sql`coalesce(${platformRefunds.processedAt}, now())` }
        : {}),
    })
    .where(eq(platformRefunds.id, reserved.id))

  return {
    refundId: reserved.id,
    amount: reserved.amount,
    status,
    gatewayRefundId: gatewayRefund.id,
    deduplicated: false,
  }
}

/**
 * Razorpay's refund status → ours.
 *
 * The three words are identical on purpose (0083), so this is a VALIDATION not
 * a translation: anything unrecognised falls back to 'pending', never to
 * 'processed'. Treating an unknown provider status as "the money has left"
 * would be a guess in the one direction that cannot be taken back.
 */
export function normaliseRefundStatus(raw: string): 'pending' | 'processed' | 'failed' {
  if (raw === 'processed') return 'processed'
  if (raw === 'failed') return 'failed'
  return 'pending'
}

/**
 * Settle a refund from a VERIFIED webhook (`refund.processed` / `refund.failed`).
 *
 * Matched on OUR OWN stored `gateway_refund_id`, never on anything else in the
 * payload — the same identity rule the subscription webhook follows. A refund
 * Razorpay knows about but we never created is ignored rather than invented:
 * inserting a refund from a payload would let a delivery decide that money left
 * an account, which is precisely what "never trust the payload" forbids.
 *
 * Idempotent by construction: the update is a SET to a fixed value, so a
 * redelivery writes the same row again and changes nothing. It refuses to move
 * a refund OUT of a final state, so a delayed `refund.processed` cannot
 * resurrect one that has since failed, or the reverse.
 */
export async function applyVerifiedRefundEvent(
  tx: DB,
  params: {
    gatewayRefundId: string
    status: 'processed' | 'failed'
    /**
     * The payment the gateway says this refund came from, for the ADOPTION path
     * below. Null when the delivery did not carry one, which simply means the
     * fallback cannot run.
     */
    gatewayPaymentId?: string | null
    /** The gateway's amount in paise, to disambiguate. Null when absent. */
    amountPaise?: number | null
  },
): Promise<{ kind: 'applied' | 'unchanged' | 'ignored'; tenantId?: string }> {
  let [row] = await tx
    .select({
      id: platformRefunds.id,
      tenantId: platformRefunds.tenantId,
      status: platformRefunds.status,
    })
    .from(platformRefunds)
    .where(
      and(
        eq(platformRefunds.gateway, GATEWAY),
        eq(platformRefunds.gatewayRefundId, params.gatewayRefundId),
      ),
    )
    .for('update')
    .limit(1)

  // ── ADOPTION: the refund we instructed but never got an id for ─────────────
  //
  // refundPlatformInvoice() phase 2 has an UNKNOWN branch: the gateway was told
  // to refund and did not answer in time (a timeout, a 5xx). The row stays
  // 'pending' with a NULL gateway_refund_id, holding its reservation, and the
  // header above promises that "the webhook will settle it".
  //
  // It could not. The lookup above matches on gateway_refund_id, and a NULL
  // column matches nothing — so `refund.processed` returned 'ignored' and the
  // row stayed pending FOREVER. Three things followed from that, all durable:
  // refundedForInvoice() counts 'pending', so that slice of the invoice was
  // permanently unrefundable and a re-attempt was refused for "exceeding the
  // refundable amount"; processed_at was never stamped, so money that had
  // genuinely left never appeared in the AROS-114 revenue series; and no
  // operator path existed to clear it.
  //
  // So when the reference is unknown, the refund is matched instead by the
  // PAYMENT it came from — the one fact both sides always agree on, because
  // gateway_payment_id is copied from the locked invoice at reservation time.
  //
  // Deliberately narrow, because adopting the wrong row would settle a refund
  // that never happened:
  //
  //   * only rows still 'pending' AND still missing an id — a refund we already
  //     have a reference for is not this one;
  //   * only when the amounts agree, when the delivery states one;
  //   * only when EXACTLY ONE candidate remains. Two indistinguishable pending
  //     refunds on one payment are left alone for a human, which is the
  //     fail-closed direction: a stuck row is recoverable, a wrongly-settled
  //     one is money.
  //
  // The unique index idx_platform_refunds_gateway_ref then makes the adoption
  // itself safe: a second delivery for the same rfnd_… cannot claim a second
  // row, it collides.
  if (!row && params.gatewayPaymentId) {
    const candidates = await tx
      .select({
        id: platformRefunds.id,
        tenantId: platformRefunds.tenantId,
        status: platformRefunds.status,
        amount: platformRefunds.amount,
      })
      .from(platformRefunds)
      .where(
        and(
          eq(platformRefunds.gateway, GATEWAY),
          eq(platformRefunds.gatewayPaymentId, params.gatewayPaymentId),
          eq(platformRefunds.status, 'pending'),
          isNull(platformRefunds.gatewayRefundId),
        ),
      )
      .for('update')

    const matched =
      typeof params.amountPaise === 'number'
        ? candidates.filter((r) => paise(round2(Number(r.amount))) === params.amountPaise)
        : candidates

    if (matched.length !== 1) {
      if (matched.length > 1) {
        console.warn(
          `[platform-refund] ${params.gatewayRefundId} matches ${matched.length} unsettled ` +
            `refunds on payment ${params.gatewayPaymentId}; left for manual reconciliation`,
        )
      }
      return { kind: 'ignored' }
    }

    // Claim it, so every later delivery for this refund takes the fast path
    // above and the reference is on record for a dispute.
    await tx
      .update(platformRefunds)
      .set({ gatewayRefundId: params.gatewayRefundId })
      .where(eq(platformRefunds.id, matched[0].id))

    row = matched[0]
  }

  if (!row) return { kind: 'ignored' }
  // Final is final. Both directions.
  if (row.status !== 'pending') {
    return { kind: 'unchanged', tenantId: row.tenantId }
  }

  await tx
    .update(platformRefunds)
    .set({
      status: params.status,
      // The moment the money actually left, for the revenue series (0085). Only
      // on 'processed' — a failed refund never settled and must keep a null
      // here rather than a timestamp that would read as a cash movement.
      ...(params.status === 'processed'
        ? { processedAt: sql`coalesce(${platformRefunds.processedAt}, now())` }
        : {}),
    })
    .where(eq(platformRefunds.id, row.id))

  return { kind: 'applied', tenantId: row.tenantId }
}
