import { Star } from 'lucide-react'
import type { PublicGoogleReviews } from '@/lib/reviews/public'

/**
 * Google reviews on the public homepage (0106, Feature B).
 *
 * Reads NOTHING itself — it is handed the cache's output. The homepage does not
 * call Google, because a public page that made a third-party request per render
 * would go down whenever Google did, and Business Profile quota is per project
 * and shared across every tenant.
 *
 * ── Absent by default ──────────────────────────────────────────────────────
 *
 * A venue that has not connected a Business Profile has no cached rows, so the
 * caller renders nothing and the page looks exactly as it does today. That is
 * the requirement rather than a nicety: API access needs a Google application,
 * a verified profile live 60+ days and a verified OAuth consent screen, so most
 * tenants will never have it and their homepage must not care.
 *
 * ── No review gating, and no editorialising ────────────────────────────────
 *
 * Whatever is cached is shown, newest first, one-star reviews included. There
 * is no filter by rating here or anywhere upstream: hiding the unflattering
 * ones would misrepresent a rating Google publishes in full anyway.
 */
export function GoogleReviewsSection({ data }: { data: PublicGoogleReviews }) {
  if (data.reviews.length === 0) return null

  return (
    <section id="reviews" className="scroll-mt-16 border-t border-border bg-muted/20">
      <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">What our guests say</h2>
          <div className="mt-3 flex items-center justify-center gap-2">
            <Stars rating={Math.round(data.averageRating)} />
            <span className="text-sm font-semibold text-foreground">
              {data.averageRating.toFixed(1)}
            </span>
            {/* Says "on Google" so a visitor knows these are not moderated by
                the venue — that is what makes them worth reading. */}
            <span className="text-sm text-muted-foreground">
              from {data.count} {data.count === 1 ? 'review' : 'reviews'} on Google
            </span>
          </div>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.reviews.map((r) => (
            <figure
              key={r.id}
              className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-sm"
            >
              <Stars rating={r.rating} />
              {r.comment && (
                <blockquote className="mt-3 flex-1 text-sm leading-relaxed text-foreground">
                  {r.comment}
                </blockquote>
              )}
              <figcaption className="mt-4 flex items-center gap-2.5 text-xs">
                {/* Deliberately no <img>, even though r.reviewerPhotoUrl is
                    now available (0107): rendering it would hotlink a
                    googleusercontent URL on every homepage render, leaking each
                    visitor's IP to Google and breaking whenever the URL
                    rotates. Initials cost nothing and cannot 404. The field is
                    kept so switching to avatars is a decision made HERE — and a
                    privacy one, not a styling one — rather than a re-sync. */}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                  {initials(r.reviewerName)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-foreground">
                    {/* Google's own wording for a reviewer who chose anonymity. */}
                    {r.reviewerName ?? 'A Google user'}
                  </span>
                  <time
                    dateTime={r.reviewCreatedAt}
                    className="block text-muted-foreground"
                  >
                    {monthYear(r.reviewCreatedAt)}
                  </time>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={14}
          aria-hidden
          className={n <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'}
        />
      ))}
    </div>
  )
}

/** Up to two initials, or a neutral mark for an anonymous reviewer. */
function initials(name: string | null): string {
  if (!name) return '★'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '★'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

/**
 * "March 2026". Fixed en-GB rather than the server's locale, and UTC rather
 * than the venue's timezone: a review's month is not a booking instant, and
 * en-GB keeps the wording stable wherever the server happens to run — the same
 * reasoning lib/format.ts prettyDate() follows.
 */
function monthYear(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso))
}
