'use client'

import { useState, useTransition } from 'react'
import { dateWithYearInZone, dateTimeInZone } from '@/lib/format'
import { useRouter } from 'next/navigation'
import { Loader2, CheckCircle2, AlertTriangle, Star } from 'lucide-react'
import { Section } from './BusinessProfileForm'
import {
  saveGoogleOAuthClientAction,
  disconnectGoogleBusiness,
  syncGoogleReviewsNow,
} from '@/lib/actions/google-business'

/**
 * Connect a venue's own Google Business Profile, so its reviews can be shown on
 * its homepage (0128).
 *
 * Sits beside the Google review LINK on the same settings page, because an
 * owner thinks of both as "our Google stuff" — but they are two independent
 * features and either works without the other. The link needs no API access at
 * all; this needs a Cloud project.
 *
 * ── What is never rendered ─────────────────────────────────────────────────
 *
 * The stored client secret and refresh token are write-only from this screen.
 * `status` comes from getGoogleConnectionStatus(), which selects neither, so
 * there is no code path by which a secret could reach this component — the
 * fields below are blank on every load and only ever send new values.
 */

export type ConnectionStatus = {
  accountId: string
  locationId: string
  clientId: string
  authorised: boolean
  connectedAt: string
  lastSyncedAt: string | null
  lastSyncError: string | null
}

const input =
  'w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground/60 hover:border-foreground/30 focus:border-primary focus:ring-2 focus:ring-ring/30 disabled:opacity-60'

export function GoogleBusinessForm({
  status,
  timeZone,
}: {
  status: ConnectionStatus | null
  /** The venue's clock. Required because these stamps are SSR-ed and then
   *  hydrated: 'en-GB' pinned the LOCALE but left the timezone to the runtime,
   *  so the time rendered on the server and the time rendered in the browser
   *  disagreed whenever the two were in different zones. */
  timeZone: string
}) {
  const router = useRouter()
  const [fields, setFields] = useState({
    accountId: status?.accountId ?? '',
    locationId: status?.locationId ?? '',
    clientId: status?.clientId ?? '',
    clientSecret: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const set = (patch: Partial<typeof fields>) => {
    setFields((f) => ({ ...f, ...patch }))
    setSaved(false)
    setError(null)
  }

  const complete = Object.values(fields).every((v) => v.trim().length > 0)

  return (
    <div className="mt-6">
      <Section
        icon={<Star size={18} />}
        title="Google reviews on your homepage"
        description="Optional, and separate from the review link above. Connect your Google Business Profile and we will show your existing Google reviews on your homepage."
      >
        {/* The real cost, stated up front rather than discovered halfway through.
            Most venues will not do this, and that is a fine outcome — the homepage
            simply carries on without a reviews section. */}
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
          <p>
            This needs your own Google Cloud project: enable the Business Profile API, create an OAuth client, and
            authorise it against your profile. Google also has to approve API access for the project, which can take
            a couple of weeks. Your quota and approval are yours alone — they are not shared with other venues.
          </p>
        </div>

        {status && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={16} className="text-emerald-500" aria-hidden />
              Connected {dateWithYearInZone(status.connectedAt, timeZone)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status.lastSyncedAt
                ? `Last synced ${dateTimeInZone(status.lastSyncedAt, timeZone)}`
                : 'Not synced yet.'}
            </p>
            {/* A failing connection must be visible here rather than only in logs
                — it is the difference between "no reviews yet" and "broken". */}
            {status.lastSyncError && (
              <p className="mt-1.5 text-xs text-destructive">Last sync failed: {status.lastSyncError}</p>
            )}
          </div>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="gAccount" label="Google account id" hint="From your Business Profile API account list. `accounts/123` or just `123`.">
            <input id="gAccount" value={fields.accountId} onChange={(e) => set({ accountId: e.target.value })} disabled={pending} placeholder="accounts/123456789" className={input} autoCorrect="off" spellCheck={false} />
          </Field>

          <Field id="gLocation" label="Google location id" hint="The location whose reviews you want to show.">
            <input id="gLocation" value={fields.locationId} onChange={(e) => set({ locationId: e.target.value })} disabled={pending} placeholder="locations/987654321" className={input} autoCorrect="off" spellCheck={false} />
          </Field>

          <Field id="gClientId" label="OAuth client id" hint="From your own Google Cloud project's OAuth credentials.">
            <input id="gClientId" value={fields.clientId} onChange={(e) => set({ clientId: e.target.value })} disabled={pending} placeholder="…apps.googleusercontent.com" className={input} autoCorrect="off" spellCheck={false} />
          </Field>

          <Field id="gClientSecret" label="OAuth client secret" hint="Stored encrypted and never shown again — leave blank only if you are not changing it.">
            <input id="gClientSecret" type="password" value={fields.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} disabled={pending} placeholder="••••••••" className={input} autoComplete="off" />
          </Field>
        </div>

        {error && (
          <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2.5 border-t border-border pt-5">
          <button
            type="button"
            disabled={pending || !complete}
            onClick={() =>
              start(async () => {
                const r = await saveGoogleOAuthClientAction(fields)
                if (r.error) return setError(r.error)
                // Cleared immediately: nothing keeps a secret in browser memory
                // longer than the request that sent it.
                setFields((f) => ({ ...f, clientSecret: '' }))
                setSaved(true)
                router.refresh()
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {pending ? 'Saving…' : status ? 'Update connection' : 'Connect'}
          </button>

          {/* Step two. A LINK, not a button calling an action: the outcome is a
              cross-origin redirect to Google, which a server action cannot
              produce. Only offered once a client pair exists — there is nothing
              to authorise against otherwise. */}
          {status && (
            <a
              href="/api/oauth/google-business/start"
              className={
                status.authorised
                  ? 'rounded-lg border border-border px-4 py-2.5 text-sm transition hover:bg-muted'
                  : 'rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90'
              }
            >
              {status.authorised ? 'Re-authorise with Google' : 'Authorise with Google'}
            </a>
          )}

          {/* Only once there is a token to sync WITH — before that the answer is
              always "authorise first", which the status line already says. */}
          {status?.authorised && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null)
                  setSyncNote(null)
                  const r = await syncGoogleReviewsNow()
                  if (r.error) return setError(r.error)
                  setSyncNote(
                    `Synced ${r.synced ?? 0} review${r.synced === 1 ? '' : 's'}` +
                      (r.skipped ? `, skipped ${r.skipped} Google could not be stored` : ''),
                  )
                  router.refresh()
                })
              }
              className="rounded-lg border border-border px-4 py-2.5 text-sm transition hover:bg-muted disabled:opacity-50"
            >
              Sync now
            </button>
          )}

          {status && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await disconnectGoogleBusiness()
                  if (r.error) return setError(r.error)
                  router.refresh()
                })
              }
              className="rounded-lg border border-destructive/30 px-4 py-2.5 text-sm text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
            >
              Disconnect
            </button>
          )}

          {saved && !pending && (
            <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 size={15} aria-hidden /> Saved
            </span>
          )}
          {syncNote && !pending && <span className="text-sm text-muted-foreground">{syncNote}</span>}
        </div>
      </Section>
    </div>
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}
