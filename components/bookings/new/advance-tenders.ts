/**
 * Pure helpers for the staff "collected upfront" split-tender entry (M30 #5).
 * Shared by the editor (what the running total shows) and both wizards' submit
 * (what is sent), so the two can never disagree: the total is always computed
 * from exactly the list that gets sent.
 *
 * Deliberately free of server imports (lib/billing/payments pulls in the db
 * schema) so a client component can use it.
 */
export const ADVANCE_METHODS = ['cash', 'card', 'upi'] as const
export type AdvanceMethod = (typeof ADVANCE_METHODS)[number]

export const ADVANCE_METHOD_LABELS: Record<AdvanceMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
}

/** One editable row — `amount` stays a string so an empty field is empty, not "0". */
export type AdvanceTenderRow = { key: number; method: AdvanceMethod; amount: string }
export type AdvanceTenderPayload = { method: AdvanceMethod; amount: number }

/**
 * The rows that will actually be sent: finite, strictly positive amounts only,
 * rounded to paise. Empty / zero / negative / garbage rows are dropped here so a
 * careless blank row never reaches the server as a confusing error.
 */
export function cleanAdvanceTenders(rows: AdvanceTenderRow[]): AdvanceTenderPayload[] {
  const out: AdvanceTenderPayload[] = []
  for (const r of rows) {
    const n = Math.round(Number(r.amount) * 100) / 100
    if (r.amount.trim() !== '' && Number.isFinite(n) && n > 0) out.push({ method: r.method, amount: n })
  }
  return out
}

/** Sum of the tenders that will be sent, in rupees (summed in paise to avoid float drift). */
export function sumAdvanceTenders(tenders: AdvanceTenderPayload[]): number {
  return tenders.reduce((paise, t) => paise + Math.round(t.amount * 100), 0) / 100
}
