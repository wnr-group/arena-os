/**
 * Customer text after staff move a booking.
 *
 * Sent by the action AFTER the reschedule commits, never inside it - a real
 * provider means network I/O. Records one `notifications` row and never throws,
 * like every other notification here.
 */
import 'server-only'
import { and, eq } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { bookings, notifications } from '@/db/schema'
import { getConfiguredProvider } from './provider'

export type BookingRescheduledInfo = {
  oldStartsAt: Date
  newStartsAt: Date
  newEndsAt: Date
  timeZone: string
}

function when(d: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${date}, ${time}`
}

// Copy to be reviewed before a real SMS provider is switched on.
export function rescheduledText(bookingNumber: string, i: BookingRescheduledInfo): string {
  return `Your booking ${bookingNumber} has been moved from ${when(i.oldStartsAt, i.timeZone)} to ${when(i.newStartsAt, i.timeZone)}. Please contact us if this doesn't work for you.`
}

export async function sendBookingRescheduledNotification(
  tenantId: string,
  bookingId: string,
  info: BookingRescheduledInfo,
): Promise<void> {
  try {
    const [b] = await ownerDb
      .select({ bookingNumber: bookings.bookingNumber, customerId: bookings.customerId, customerPhone: bookings.customerPhone })
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
      .limit(1)
    if (!b) return
    const text = rescheduledText(b.bookingNumber, info)
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
        console.error('[notifications] reschedule send failed:', e instanceof Error ? e.message : e)
        status = 'failed'
        skipReason = 'provider_error'
      }
    }
    await ownerDb.insert(notifications).values({
      tenantId,
      customerId: b.customerId,
      orderId: null,
      channel: 'sms',
      kind: 'booking_rescheduled',
      recipientPhone: b.customerPhone,
      messageBody: text,
      status,
      skipReason,
      providerMessageId,
    })
  } catch (e) {
    console.error('[notifications] reschedule notification failed:', e instanceof Error ? e.name : 'unknown')
  }
}
