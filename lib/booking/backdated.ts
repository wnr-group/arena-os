/**
 * Backdated booking entry (M28 #2) — an owner/manager back-fills a session
 * that already happened but was never logged. One transaction: create the
 * booking (flagged `backdated`), raise its invoice, take the tender, and mark
 * it completed once settled.
 *
 * This is orchestration only. Pricing (priceBookingSlots resolves
 * weekend/holiday/happy-hour/per-head off each slot's own startsAt),
 * numbering, GST and payments are the untouched shared primitives. The
 * invoice is stamped with the real "now" by issueInvoiceForBooking — the
 * paperwork is never backdated, only the session.
 */
import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookings } from '@/db/schema'
import { createBookingCore, BookingError, type CreateBookingSlotInput } from '@/lib/booking/service'
import { issueInvoiceForBooking, writeAudit } from '@/lib/billing/invoice'
import { recordPaymentForInvoice, getInvoiceSettlement, paise, type PosPaymentMethod } from '@/lib/billing/payments'
import { todayInZone } from '@/lib/booking/time'

type Db = NodePgDatabase<typeof schema>

/** How far back a session may be entered. */
export const BACKDATED_MAX_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export type RecordBackdatedInput = {
  branchId: string
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  notes?: string
  slots: CreateBookingSlotInput[]
  headCount?: number
  /** What was actually collected. 0 is allowed only when the bill is ₹0. */
  amountCollected: number
  paymentMethod: PosPaymentMethod
  idempotencyKey?: string
}

export type RecordedBackdatedBooking = {
  bookingId: string
  bookingNumber: string
  invoiceId: string
  invoiceNumber: string
  /** True when the tender settled the bill and the booking landed completed. */
  completed: boolean
}

/**
 * The server-side window: every slot must have started within the last 7 days
 * and already ended. Enforced here, never trusted to the UI's date picker.
 */
export function assertBackdatedWindow(slots: { startsAt: string; endsAt: string }[], now: Date = new Date()): void {
  const earliest = now.getTime() - BACKDATED_MAX_DAYS * DAY_MS
  for (const s of slots) {
    const start = new Date(s.startsAt).getTime()
    const end = new Date(s.endsAt).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new BookingError('Enter a valid date and time.')
    if (end <= start) throw new BookingError('The end time must be after the start time.')
    if (end > now.getTime()) {
      throw new BookingError('A backdated booking must have already ended. Use a normal booking for a session still to come.')
    }
    if (start < earliest) {
      throw new BookingError(`Backdated bookings can only be entered up to ${BACKDATED_MAX_DAYS} days back.`)
    }
  }
}

/** Steps 1-2 of the flow (window check, booking, invoice) — shared by the real
 *  entry and the rolled-back preview so the two can never disagree. */
async function createAndBill(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string },
  input: Omit<RecordBackdatedInput, 'amountCollected' | 'paymentMethod' | 'idempotencyKey'>,
  now: Date,
) {
  assertBackdatedWindow(input.slots, now)

  const created = await createBookingCore(tx, ctx, {
    branchId: input.branchId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail,
    notes: input.notes,
    source: 'staff',
    discount: 0,
    deposit: 0,
    slots: input.slots,
    headCount: input.headCount,
    backdated: true,
  })

  const invoice = await issueInvoiceForBooking(tx, { id: ctx.tenantId, timezone: ctx.timezone }, { bookingId: created.id })
  return { created, invoice }
}

export async function recordBackdatedBookingCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string },
  input: RecordBackdatedInput,
): Promise<RecordedBackdatedBooking> {
  const now = new Date()
  const amount = input.amountCollected
  if (!Number.isFinite(amount) || amount < 0) throw new BookingError('Amount collected must be zero or more.')

  // Idempotent on the client's key: a double-click or a retry after a commit
  // whose response was lost must return the booking already recorded, not
  // collide with its own slot (23P01) and invite a duplicate on another
  // resource. The advisory lock makes a concurrent second call wait for the
  // first to commit, then find it here.
  const key = input.idempotencyKey
  if (key) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`backdated:${ctx.tenantId}:${key}`}))`)
    const [prior] = await tx
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, ctx.tenantId),
          eq(auditLog.action, 'booking.backdated_entry'),
          sql`${auditLog.after}->>'idempotencyKey' = ${key}`,
        ),
      )
      .limit(1)
    const a = prior?.after as
      | { bookingId?: string; bookingNumber?: string; invoiceId?: string; invoiceNumber?: string; completed?: boolean }
      | undefined
    if (a?.bookingId && a.bookingNumber && a.invoiceId && a.invoiceNumber) {
      return {
        bookingId: a.bookingId,
        bookingNumber: a.bookingNumber,
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoiceNumber,
        completed: Boolean(a.completed),
      }
    }
  }

  const { created, invoice } = await createAndBill(tx, ctx, input, now)

  if (paise(amount) > 0) {
    await recordPaymentForInvoice(
      tx,
      { tenantId: ctx.tenantId, membershipId: ctx.membershipId },
      {
        invoiceId: invoice.invoiceId,
        method: input.paymentMethod,
        amount,
        idempotencyKey: input.idempotencyKey,
      },
    )
  }

  // Complete directly rather than via completeBookingIfFullySettled: that
  // shared function deliberately skips restaurants (a live table needs its
  // "cleaning" step), which does not apply to a session that is already over.
  // It stays untouched for every real-time caller.
  const settlement = await getInvoiceSettlement(tx, ctx.tenantId, invoice.invoiceId)
  if (!settlement) throw new Error(`Settlement missing for invoice ${invoice.invoiceId}.`)
  let completed = false
  if (!settlement.payable) {
    const done = await tx
      .update(bookings)
      .set({ status: 'completed', completedAt: now })
      .where(
        and(
          eq(bookings.id, created.id),
          eq(bookings.tenantId, ctx.tenantId),
          inArray(bookings.status, ['confirmed', 'checked_in']),
        ),
      )
      .returning({ id: bookings.id })
    completed = done.length > 0
  }

  await writeAudit(tx, ctx, {
    action: 'booking.backdated_entry',
    entityType: 'booking',
    entityId: created.id,
    before: {},
    after: {
      bookingId: created.id,
      bookingNumber: created.bookingNumber,
      idempotencyKey: key ?? null,
      enteredAt: now.toISOString(),
      enteredOn: todayInZone(ctx.timezone, now),
      slots: input.slots.map((s) => ({ resourceId: s.resourceId, startsAt: s.startsAt, endsAt: s.endsAt })),
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      amountCollected: amount,
      paymentMethod: input.paymentMethod,
      completed,
    },
  })

  return {
    bookingId: created.id,
    bookingNumber: created.bookingNumber,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    completed,
  }
}

export type BackdatedPreview = { subtotal: number; discount: number; tax: number; total: number }

/** Thrown to abort the preview's transaction — nothing it wrote survives. */
class PreviewRollback extends Error {
  constructor(readonly preview: BackdatedPreview) {
    super('backdated preview rollback')
  }
}

/**
 * What recording this entry would bill, computed by running the REAL
 * create + invoice path and rolling the transaction back. Going through the
 * same code (weekend/holiday/happy-hour/per-head rates, GST, any membership
 * benefit) is what keeps the estimate from ever disagreeing with the charge.
 * Pass a `run` that opens the transaction (withUser) — this rethrows any real
 * error (window, overlap, validation) so the caller can show it inline.
 */
export async function previewBackdatedBooking(
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>,
  ctx: { tenantId: string; timezone: string; membershipId: string },
  input: Omit<RecordBackdatedInput, 'amountCollected' | 'paymentMethod' | 'idempotencyKey'>,
): Promise<BackdatedPreview> {
  try {
    await run(async (tx) => {
      const { invoice } = await createAndBill(tx, ctx, input, new Date())
      const p = invoice.pricing
      throw new PreviewRollback({ subtotal: p.subtotal, discount: p.discount, tax: p.taxTotal, total: p.total })
    })
  } catch (e) {
    if (e instanceof PreviewRollback) return e.preview
    throw e
  }
  throw new Error('unreachable')
}
