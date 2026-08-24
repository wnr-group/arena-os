import { formatMoney, prettyDate } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { cn } from '@/lib/utils/cn'
import type { PortalLedgerEntry } from '@/lib/portal/wallet'

/**
 * One statement — wallet or loyalty — rendered from the append-only ledger.
 *
 * A server component; nothing here is interactive.
 *
 * Both ledgers store a SIGNED value (wallet_transactions.amount,
 * loyalty_transactions.points — see 0014), so the sign IS the semantics: this
 * component reads it rather than inferring credit/debit from `source_type`,
 * which is free text and would have to be kept in step with the till.
 */

/**
 * Human wording for the `source_type` values the ledgers actually carry.
 *
 * Unmapped values fall back to the row's own `reason`, then to a neutral label,
 * so a source type added by a later ticket degrades to something readable
 * instead of showing a raw enum to a customer.
 */
const SOURCE_LABELS: Record<string, string> = {
  topup: 'Wallet top-up',
  booking: 'Booking payment',
  refund: 'Refund',
  adjustment: 'Adjustment',
  invoice: 'Invoice payment',
  invoice_earn: 'Points earned',
  invoice_redeem: 'Points redeemed',
  earn_reversal: 'Points reversed',
  redeem_reversal: 'Redemption returned',
}

function describe(entry: PortalLedgerEntry): string {
  const mapped = entry.sourceType ? SOURCE_LABELS[entry.sourceType] : undefined
  return mapped ?? entry.reason?.trim() ?? 'Activity'
}

export function LedgerList({
  title,
  entries,
  emptyMessage,
  timeZone,
  /** 'money' formats with the venue currency; 'points' renders "+10 pts". */
  kind,
  currency,
}: {
  title: string
  entries: PortalLedgerEntry[]
  emptyMessage: string
  timeZone: string
  kind: 'money' | 'points'
  currency: string
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">{title}</h2>

      {entries.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => {
            const value = Number(entry.amount)
            // Zero should not claim to be a credit. Only a genuine negative
            // renders as a debit.
            const isDebit = value < 0
            const magnitude = Math.abs(value)

            return (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{describe(entry)}</p>
                  <p className="text-xs text-muted-foreground">
                    {prettyDate(todayInZone(timeZone, entry.createdAt), timeZone)}
                  </p>
                </div>

                <span
                  className={cn(
                    'shrink-0 text-sm font-medium tabular-nums',
                    isDebit ? 'text-destructive' : 'text-emerald-600',
                  )}
                >
                  {isDebit ? '−' : '+'}
                  {kind === 'money'
                    ? formatMoney(magnitude, currency)
                    : `${magnitude} ${magnitude === 1 ? 'pt' : 'pts'}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
