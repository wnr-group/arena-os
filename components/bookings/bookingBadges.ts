// Badge styles and labels shared by the day view's bookings table, the multi-day
// list (M34 #4) and the booking detail panel.

/**
 * Payment badges. "Unbilled" is the absence of an invoice rather than a state
 * of one, so it is styled quietly — it is the normal condition of a booking
 * that has not reached the till yet, not something to chase.
 */
export const PAYMENT_BADGE: Record<string, string> = {
  paid: 'bg-emerald-600 text-white',
  partially_paid: 'bg-amber-500 text-white',
  issued: 'bg-rose-600 text-white',
  partially_refunded: 'bg-orange-500 text-white',
  refunded: 'bg-zinc-600 text-white',
  unbilled: 'bg-muted text-muted-foreground',
}
export const PAYMENT_LABELS: Record<string, string> = {
  paid: 'Paid',
  partially_paid: 'Part paid',
  issued: 'Unpaid',
  partially_refunded: 'Part refunded',
  refunded: 'Refunded',
  unbilled: 'Unbilled',
}

export const STATUS_BADGE: Record<string, string> = {
  pending_payment: 'bg-amber-500/10 text-amber-600',
  confirmed: 'bg-blue-500/10 text-blue-600',
  checked_in: 'bg-emerald-500/10 text-emerald-600',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  no_show: 'bg-amber-500/10 text-amber-600',
}
export const STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}
export const SOURCE_BADGE: Record<string, string> = {
  online: 'bg-accent text-primary',
  walk_in: 'bg-muted text-muted-foreground',
  staff: 'bg-muted text-muted-foreground',
}
export const SOURCE_LABELS: Record<string, string> = {
  online: 'Online',
  walk_in: 'Walk-in',
  staff: 'Staff',
}
