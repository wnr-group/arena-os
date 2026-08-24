import { Award } from 'lucide-react'
import type { TierStanding } from '@/lib/loyalty/tiers'

/**
 * The customer's standing on the venue's tier ladder.
 *
 * A server component; nothing here is interactive. All arithmetic already
 * happened in computeTierStanding() — this file does no comparisons of its own,
 * so the rule cannot drift between the portal and anywhere else that shows a
 * tier.
 *
 * Returns null when the venue has no ladder at all, so a tenant that has
 * deliberately emptied loyalty_tiers simply gets no section rather than an
 * empty box.
 */
export function TierCard({ standing }: { standing: TierStanding }) {
  const { currentTier, nextTier, progress } = standing

  // No ladder configured, and no rung reached on a ladder that starts above
  // zero — nothing meaningful to show either way.
  if (!currentTier && !nextTier) return null

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Award size={16} />
        Loyalty tier
      </p>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
        <p className="text-2xl font-semibold">{currentTier?.name ?? 'Not yet earned'}</p>
        {progress.isMaxTier && currentTier && (
          <span className="text-xs font-medium text-muted-foreground">Top tier</span>
        )}
      </div>

      {currentTier?.perk && (
        <p className="mt-0.5 text-sm text-muted-foreground">{currentTier.perk}</p>
      )}

      <div className="mt-3">
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            nextTier ? `Progress toward ${nextTier.name}` : 'Highest tier reached'
          }
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress.percentage}%` }}
          />
        </div>

        <p className="mt-1.5 text-xs text-muted-foreground">
          {nextTier ? (
            <>
              {progress.currentPoints} / {progress.nextThreshold} points ·{' '}
              <strong className="font-medium text-foreground">
                {progress.pointsToNext} more
              </strong>{' '}
              to reach {nextTier.name}
            </>
          ) : (
            <>
              {progress.currentPoints} points earned — you have reached the highest tier.
            </>
          )}
        </p>
      </div>

      {/* Said plainly, because the two numbers on this page differ and a
          customer who spots that deserves an explanation rather than a support
          ticket. */}
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        Tiers are based on points earned over time, so redeeming points never
        lowers your tier.
      </p>
    </section>
  )
}
