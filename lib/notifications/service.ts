/**
 * Sending (or gracefully skipping) an "order ready" notification — the only
 * notification kind this app sends today (M14 #7, v2).
 *
 * Takes a `tx`, same pattern as lib/kots/service.ts and lib/orders/service.ts
 * — but the caller should run this in its OWN transaction, started only
 * after the KOT-status update that triggered it has already committed. This
 * function may end up doing network I/O (a real provider's send call); it
 * must never run inside the same transaction as a row-locking status update.
 */
import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { customers, notifications } from '@/db/schema'
import { getConfiguredProvider } from './provider'

type Db = NodePgDatabase<typeof schema>

export type OrderReadyNotificationInput = {
  orderId: string
  orderNumber: string
  customerId: string | null
}

type RecordArgs = {
  status: 'sent' | 'skipped' | 'failed'
  skipReason?: string
  recipientPhone?: string | null
  providerMessageId?: string
}

/**
 * Best-effort "your order is ready" text. Always writes exactly one
 * `notifications` row recording what happened; NEVER throws — a notification
 * hiccup must never be mistaken for (or block) a kitchen-ticket update.
 */
export async function sendOrderReadyNotification(
  tx: Db,
  ctx: { tenantId: string },
  input: OrderReadyNotificationInput,
): Promise<void> {
  const messageBody = `Your order #${input.orderNumber} is ready!`

  async function record(args: RecordArgs): Promise<void> {
    await tx.insert(notifications).values({
      tenantId: ctx.tenantId,
      customerId: input.customerId,
      orderId: input.orderId,
      channel: 'sms',
      kind: 'order_ready',
      recipientPhone: args.recipientPhone ?? null,
      messageBody,
      status: args.status,
      skipReason: args.skipReason ?? null,
      providerMessageId: args.providerMessageId ?? null,
    })
  }

  if (!input.customerId) {
    return record({ status: 'skipped', skipReason: 'no_customer' })
  }

  const [customer] = await tx
    .select({ phone: customers.phone, notifyOrderReady: customers.notifyOrderReady })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.tenantId, ctx.tenantId)))
    .limit(1)

  if (!customer) {
    return record({ status: 'skipped', skipReason: 'no_customer' })
  }
  if (!customer.notifyOrderReady) {
    return record({ status: 'skipped', skipReason: 'opted_out', recipientPhone: customer.phone })
  }

  const provider = getConfiguredProvider()
  if (!provider) {
    return record({ status: 'skipped', skipReason: 'not_configured', recipientPhone: customer.phone })
  }

  try {
    const result = await provider.send(customer.phone, messageBody)
    await record({ status: 'sent', recipientPhone: customer.phone, providerMessageId: result.providerMessageId })
  } catch (e) {
    console.error('[notifications] order_ready send failed:', e instanceof Error ? e.message : e)
    await record({ status: 'failed', skipReason: 'provider_error', recipientPhone: customer.phone })
  }
}
