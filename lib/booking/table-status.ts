/**
 * A table's status on the live floor map (M17 #2) — derived, not stored.
 * Every input here already exists somewhere (the session, its open orders'
 * KOT progress, whether it has a live invoice) except `billRequestedAt`,
 * which is customer/staff intent with no other signal to derive it from
 * (see 0072_table_bill_requested.sql). Kept as one pure function so the
 * precedence between "billed" and "asked for the bill" and "still eating"
 * lives in exactly one place.
 */
export type TableStatus = 'free' | 'seated' | 'ordered' | 'served' | 'bill_requested' | 'needs_cleaning'

export type TableStatusInput = {
  /** Whether an open (confirmed/checked_in) session currently occupies the table. */
  hasBooking: boolean
  /** Whether the session already has a live (non-void) invoice — i.e. it's been billed. */
  hasLiveInvoice: boolean
  billRequestedAt: Date | string | null
  /** Count of the session's still-open (not yet billed) food orders. */
  openOrderCount: number
  /** Whether any of those open orders has a KOT the kitchen hasn't finished (not served/cancelled). */
  hasActiveKot: boolean
}

export function deriveTableStatus(input: TableStatusInput): TableStatus {
  if (!input.hasBooking) return 'free'
  // Billed takes precedence over everything else: once there's a live
  // invoice the party is checked out in every sense that matters to the
  // floor, regardless of what orders/KOTs still say.
  if (input.hasLiveInvoice) return 'needs_cleaning'
  if (input.billRequestedAt) return 'bill_requested'
  if (input.openOrderCount === 0) return 'seated'
  if (input.hasActiveKot) return 'ordered'
  return 'served'
}
