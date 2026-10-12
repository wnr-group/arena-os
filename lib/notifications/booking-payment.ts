/**
 * Customer text after a booking payment is verified (M36 #3/#4).
 *
 * Sent by the webhook route AFTER its transaction commits — never inside it,
 * because a real provider means network I/O. Only the first delivery of a
 * payment returns a bookingOutcome other than 'unchanged' (redeliveries come
 * back as duplicates), so each customer is told once. Like every notification
 * here it records one `notifications` row and never throws.
 */
import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { bookings, notifications, paymentIntents, tenants } from '@/db/schema'
import { formatMoney } from '@/lib/format'
import { getConfiguredProvider } from './provider'

export type BookingPaymentOutcome = 'confirmed' | 'reinstated' | 'paid_after_release'

// Copy to be reviewed before a real SMS provider is switched on.
function body(
  outcome: BookingPaymentOutcome,
  bookingNumber: string,
  balance: { due: string; currency: string },
): { kind: string; text: string } {
  if (outcome === 'paid_after_release') {
    return {
      kind: 'booking_refund_pending',
      text: `We received your payment for booking ${bookingNumber}, but the slot could not be held. A refund will follow and the venue will be in touch.`,
    }
  }
  const owed = Number(balance.due) > 0 ? ` Balance of ${formatMoney(balance.due, balance.currency)} is due at the venue.` : ''
  return { kind: 'booking_confirmed', text: `Your booking ${bookingNumber} is confirmed. Thank you for your payment.${owed}` }
}

export async function sendBookingPaymentNotification(
  tenantId: string,
  bookingId: string,
  outcome: BookingPaymentOutcome,
): Promise<void> {
  try {
    const [b] = await ownerDb
      .select({
        bookingNumber: bookings.bookingNumber,
        customerId: bookings.customerId,
        customerPhone: bookings.customerPhone,
        total: bookings.total,
        currency: tenants.currency,
      })
      .from(bookings)
      .innerJoin(tenants, eq(tenants.id, bookings.tenantId))
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
      .limit(1)
    if (!b) return
    // The balance is what is still owed after every verified online payment on this booking.
    const [paid] = await ownerDb
      .select({ amount: sql<string>`coalesce(sum(${paymentIntents.amount}), 0)::text` })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.bookingId, bookingId),
          eq(paymentIntents.purpose, 'booking_deposit'),
          eq(paymentIntents.status, 'paid'),
        ),
      )
    const due = Math.max(Number(b.total) - Number(paid?.amount ?? 0), 0).toFixed(2)
    const { kind, text } = body(outcome, b.bookingNumber, { due, currency: b.currency })
    const provider = getConfiguredProvider()
    let status: 'sent' | 'skipped' | 'failed' = 'skipped'
    let skipReason: string | null = null
    let providerMessageId: string | null = null
    if (!b.customerPhone) skipReason = 'no_phone'
    else if (!provider) skipReason = 'not_configured'
    else {
      try {
        const r = await provider.send(b.customerPhone, text)
        status = 'sent'
        providerMessageId = r.providerMessageId ?? null
      } catch (e) {
        console.error('[notifications] booking payment send failed:', e instanceof Error ? e.message : e)
        status = 'failed'
        skipReason = 'provider_error'
      }
    }
    await ownerDb.insert(notifications).values({
      tenantId,
      customerId: b.customerId,
      orderId: null,
      channel: 'sms',
      kind,
      recipientPhone: b.customerPhone,
      messageBody: text,
      status,
      skipReason,
      providerMessageId,
    })
  } catch (e) {
    console.error('[notifications] booking payment notification failed:', e instanceof Error ? e.name : 'unknown')
  }
}
