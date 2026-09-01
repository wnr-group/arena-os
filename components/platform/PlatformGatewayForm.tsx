'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  savePlatformGateway,
  clearPlatformRazorpaySecret,
  clearPlatformRazorpayWebhookSecret,
} from '@/lib/actions/platform-gateway'

/**
 * ARENA OS's OWN Razorpay credentials — the account that charges businesses
 * their subscription (M16 #3).
 *
 * ── What this component is allowed to receive ───────────────────────────────
 *
 * `razorpayKeyId` (publishable) and two booleans. That is the entire surface.
 * Neither secret is ever a prop, in state on load, or in the server-rendered
 * HTML — not as plaintext and not as ciphertext. The key id is shown because
 * seeing `rzp_test_…` vs `rzp_live_…` is how an operator confirms WHICH account
 * is wired up; the secrets are never displayed after storage, only their
 * presence.
 *
 * Both secret inputs start EMPTY on every load and stay empty unless a
 * replacement is typed. An empty field means "keep what is stored"; removing a
 * secret is a separate, explicit button, so a credential can never be wiped by
 * saving a form that was only meant to change the key id.
 *
 * This file must not import from lib/platform/billing/* or lib/security/* —
 * those are server-only modules and pulling one in here would be a build error.
 * That is the boundary working as intended.
 */

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
const label = 'text-xs font-medium text-muted-foreground'

export function PlatformGatewayForm({
  razorpayKeyId,
  hasSecret,
  hasWebhookSecret,
  webhookUrl,
}: {
  razorpayKeyId: string
  hasSecret: boolean
  hasWebhookSecret: boolean
  /** The URL to register on the PLATFORM Razorpay account. Not a secret. */
  webhookUrl: string
}) {
  const router = useRouter()
  const [keyId, setKeyId] = useState(razorpayKeyId)
  // Never seeded from the server. Blank means "leave the stored secret alone".
  const [keySecret, setKeySecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function touch() {
    setSaved(false)
    setError(null)
  }

  const keyIdError =
    !keyId.trim() && (keySecret.trim() || hasSecret)
      ? 'A key ID is required whenever a key secret is stored.'
      : null

  function run(fn: () => Promise<{ error?: string }>, after?: () => void) {
    if (pending) return
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) {
        setError(r.error)
        return
      }
      after?.()
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="mt-6 space-y-6">
      {error && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
          Saved.
        </p>
      )}

      <section className="rounded-lg border">
        <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
          <KeyRound size={15} className="text-primary" />
          API credentials
        </h2>

        <div className="space-y-4 p-4">
          <div>
            <label className={label} htmlFor="pg-key-id">
              Key ID
            </label>
            <input
              id="pg-key-id"
              className={input}
              value={keyId}
              onChange={(e) => {
                setKeyId(e.target.value)
                touch()
              }}
              placeholder="rzp_live_…"
              autoComplete="off"
              spellCheck={false}
            />
            {keyIdError && <p className="mt-1 text-xs text-destructive">{keyIdError}</p>}
          </div>

          <div>
            <label className={label} htmlFor="pg-key-secret">
              Key secret
            </label>
            <input
              id="pg-key-secret"
              className={input}
              type="password"
              value={keySecret}
              onChange={(e) => {
                setKeySecret(e.target.value)
                touch()
              }}
              placeholder={hasSecret ? '•••••••• (stored — leave blank to keep)' : 'Not set'}
              autoComplete="new-password"
              spellCheck={false}
            />
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {hasSecret ? (
                <>
                  <ShieldCheck size={13} className="text-emerald-500" />
                  Stored, encrypted. It is never shown again.
                </>
              ) : (
                <>
                  <ShieldAlert size={13} className="text-amber-500" />
                  Not set — no business can be charged until it is.
                </>
              )}
            </p>
            {hasSecret && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(clearPlatformRazorpaySecret, () => setKeySecret(''))}
                className="mt-2 rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              >
                Remove stored key secret
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border">
        <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
          <ShieldCheck size={15} className="text-primary" />
          Webhook
        </h2>

        <div className="space-y-4 p-4">
          <div>
            <p className={label}>Webhook URL to register on the Arena OS Razorpay account</p>
            <code className="mt-1 block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              {webhookUrl}
            </code>
            <p className="mt-1 text-xs text-muted-foreground">
              Subscribe to the <code>subscription.*</code> events. This is a different URL and a
              different Razorpay account from the per-venue deposit webhook.
            </p>
          </div>

          <div>
            <label className={label} htmlFor="pg-webhook-secret">
              Webhook signing secret
            </label>
            <input
              id="pg-webhook-secret"
              className={input}
              type="password"
              value={webhookSecret}
              onChange={(e) => {
                setWebhookSecret(e.target.value)
                touch()
              }}
              placeholder={
                hasWebhookSecret ? '•••••••• (stored — leave blank to keep)' : 'Not set'
              }
              autoComplete="new-password"
              spellCheck={false}
            />
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {hasWebhookSecret ? (
                <>
                  <ShieldCheck size={13} className="text-emerald-500" />
                  Stored, encrypted. It is never returned after saving.
                </>
              ) : (
                <>
                  <ShieldAlert size={13} className="text-amber-500" />
                  Not set — every webhook delivery is rejected, so no subscription can activate.
                </>
              )}
            </p>
            {hasWebhookSecret && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(clearPlatformRazorpayWebhookSecret, () => setWebhookSecret(''))
                }
                className="mt-2 rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              >
                Remove stored webhook secret
              </button>
            )}
          </div>
        </div>
      </section>

      <button
        type="button"
        disabled={pending || keyIdError !== null}
        onClick={() =>
          run(
            () =>
              savePlatformGateway({
                razorpayKeyId: keyId,
                razorpayKeySecret: keySecret,
                razorpayWebhookSecret: webhookSecret,
              }),
            () => {
              // Clear the inputs so a stale plaintext secret cannot sit in the
              // DOM after it has been stored.
              setKeySecret('')
              setWebhookSecret('')
            },
          )
        }
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save gateway settings'}
      </button>
    </div>
  )
}
