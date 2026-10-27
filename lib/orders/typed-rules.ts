/**
 * Takeaway / delivery rules (M20 / AROS-182) — pure: no DB, no `server-only`,
 * so the service, the screens and the unit tests share one definition.
 *
 * ── THE STATUS MODEL ────────────────────────────────────────────────────────
 *   received → preparing → ready → (takeaway) collected
 *                                 → (delivery) out_for_delivery → delivered
 * The first three are NOT stored: they are the order's kitchen ticket
 * (pending → preparing → ready/served), read through `orderStage`, so the
 * kitchen and this status can never disagree. Only the handover steps after
 * the food is ready are stored (orders.handover_status).
 */

export type OrderType = 'dine_in' | 'takeaway' | 'delivery'
export type TypedOrderType = Exclude<OrderType, 'dine_in'>
export type HandoverStatus = 'out_for_delivery' | 'collected' | 'delivered'
export type KotStatus = 'pending' | 'preparing' | 'ready' | 'served' | 'cancelled'

export type OrderStage = 'received' | 'preparing' | 'ready' | 'out_for_delivery' | 'collected' | 'delivered' | 'cancelled'

export const ORDER_TYPE_LABEL: Record<OrderType, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }

export const STAGE_LABEL: Record<OrderStage, string> = {
  received: 'Received',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  collected: 'Collected',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

/** Where an order is, from its kitchen ticket + stored handover step. */
export function orderStage(input: { orderStatus: string; kotStatus: string | null; handoverStatus: HandoverStatus | null }): OrderStage {
  if (input.orderStatus === 'cancelled') return 'cancelled'
  if (input.handoverStatus) return input.handoverStatus
  switch (input.kotStatus) {
    case 'cancelled':
      return 'cancelled'
    case 'preparing':
      return 'preparing'
    case 'ready':
    case 'served':
      return 'ready'
    default:
      return 'received'
  }
}

/** Stages that end the order's life on the board. */
export const FINAL_STAGES: readonly OrderStage[] = ['collected', 'delivered', 'cancelled']
export const isFinalStage = (s: OrderStage): boolean => FINAL_STAGES.includes(s)

/** The handover step(s) that may follow `stage`, by order type. */
export function nextHandovers(orderType: OrderType, stage: OrderStage): HandoverStatus[] {
  if (orderType === 'takeaway') return stage === 'ready' ? ['collected'] : []
  if (orderType === 'delivery') {
    if (stage === 'ready') return ['out_for_delivery']
    if (stage === 'out_for_delivery') return ['delivered']
  }
  return []
}

export const HANDOVER_LABEL: Record<HandoverStatus, string> = {
  collected: 'Mark collected',
  out_for_delivery: 'Send out for delivery',
  delivered: 'Mark delivered',
}

export type TypedOrderFields = {
  orderType: TypedOrderType
  contactName: string
  contactPhone?: string | null
  deliveryAddress?: string | null
  deliveryFee?: number | null
  deliveryFeeTaxRate?: number | null
  pickupAt?: Date | null
}

export const MAX_DELIVERY_FEE = 100000

/** First problem with a takeaway/delivery order's details, or null. */
export function validateTypedOrder(i: TypedOrderFields, now: Date = new Date()): string | null {
  if (i.orderType !== 'takeaway' && i.orderType !== 'delivery') return 'Choose takeaway or delivery.'
  if (!i.contactName.trim()) return i.orderType === 'takeaway' ? 'Enter the name the order is for.' : 'Enter the customer’s name.'
  if (i.contactName.trim().length > 80) return 'The name can be at most 80 characters.'
  const phone = (i.contactPhone ?? '').replace(/\D/g, '')
  if (i.orderType === 'delivery') {
    if (!phone) return 'A delivery needs a phone number the driver can call.'
    if (!i.deliveryAddress || !i.deliveryAddress.trim()) return 'Enter the delivery address.'
    if (i.deliveryAddress.trim().length > 300) return 'The address can be at most 300 characters.'
    const fee = i.deliveryFee ?? 0
    if (!Number.isFinite(fee) || fee < 0 || fee > MAX_DELIVERY_FEE) return 'Delivery fee must be zero or more.'
    const tax = i.deliveryFeeTaxRate ?? 0
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) return 'Delivery fee GST must be between 0 and 100%.'
  } else {
    if ((i.deliveryAddress ?? '').trim() || (i.deliveryFee ?? 0) > 0) return 'A takeaway has no delivery address or fee.'
  }
  if (i.pickupAt && i.pickupAt.getTime() < now.getTime() - 5 * 60_000) return 'Pick a time that hasn’t already passed.'
  return null
}

/** Validate a handover move against the order's type and current stage. */
export function validateHandover(input: {
  orderType: OrderType
  stage: OrderStage
  to: HandoverStatus
  driverName?: string | null
}): string | null {
  if (input.orderType === 'dine_in') return 'Only takeaway and delivery orders have a handover.'
  if (isFinalStage(input.stage)) return `This order is already ${STAGE_LABEL[input.stage].toLowerCase()}.`
  if (!nextHandovers(input.orderType, input.stage).includes(input.to)) {
    if (input.stage === 'received' || input.stage === 'preparing') return 'The kitchen hasn’t finished this order yet.'
    return `A ${input.orderType} can’t go from “${STAGE_LABEL[input.stage]}” to “${STAGE_LABEL[input.to]}”.`
  }
  if (input.to === 'out_for_delivery' && !(input.driverName ?? '').trim()) return 'Enter who is delivering it.'
  return null
}

/** Whether the staff-facing order type is switched on for this venue. */
export function typeEnabled(settings: { takeawayEnabled: boolean; deliveryEnabled: boolean }, type: TypedOrderType): boolean {
  return type === 'takeaway' ? settings.takeawayEnabled : settings.deliveryEnabled
}

/** "Ready at 7:30 pm" style label helper input: minutes until a requested pickup (negative = overdue). */
export function minutesUntil(at: Date | null, now: Date): number | null {
  return at ? Math.round((at.getTime() - now.getTime()) / 60_000) : null
}
