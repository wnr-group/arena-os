'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react'
import {
  savePaymentSettings,
  clearRazorpaySecret,
  clearRazorpayWebhookSecret,
} from '@/lib/actions/payment-settings'

/**
 * Razorpay credentials form.
 *
 * ── What this component is allowed to receive ────────────────────────────────
 * `razorpayKeyId` (publishable) and `hasSecret` (a boolean). That is the entire
 * surface. The key secret is never a prop, never in state on load, and never in
 * the server-rendered HTML — not as plaintext and not as ciphertext.
 *
 * The secret input starts EMPTY on every load and stays empty unless the
 * manager types a replacement. An empty field means "keep what is stored";
 * removing a secret is a separate, explicit button.
 *
 * This file must not import from lib/settings/* or lib/security/* — those are
 * server-only modules, and pulling one in here would be a build error. That is
 * the boundary working as intended.
 */

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'

export function PaymentSettingsForm({
  razorpayKeyId,
  hasSecret,
  hasWebhookSecret,
  webhookUrl,
}: {
  razorpayKeyId: string
  hasSecret: boolean
  hasWebhookSecret: boolean
  /** The URL this tenant must register on its Razorpay account. Not a secret. */
  webhookUrl: string
}) {
  const router = useRouter()
  const [keyId, setKeyId] = useState(razorpayKeyId)
  // Never seeded from the server. A blank field is "leave the stored secret".
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

  function submit() {
    if (pending || keyIdError) return
    setError(null)
    start(async () => {
      const r = await savePaymentSettings({
        razorpayKeyId: keyId,
        razorpayKeySecret: keySecret,
        razorpayWebhookSecret: webhookSecret,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      // Drop the plaintexts from React state the moment they have been saved,
      // so they do not linger where a devtools inspection can read them.
      setKeySecret('')
      setWebhookSecret('')
      setSaved(true)
      router.refresh()
    })
  }

  function removeWebhookSecret() {
    if (pending) return
    if (
      !window.confirm(
        'Remove the stored webhook secret? Deposits will stop being confirmed automatically until a new secret is saved.',
      )
    )
      return
    setError(null)
    start(async () => {
      const r = await clearRazorpayWebhookSecret()
      if (r.error) {
        setError(r.error)
        return
      }
      setWebhookSecret('')
      setSaved(true)
      router.refresh()
    })
  }

  function removeSecret() {
    if (pending) return
    if (
      !window.confirm(
        'Remove the stored key secret? Online payments will stop working until a new secret is saved.',
      )
    )
      return
    setError(null)
    start(async () => {
      const r = await clearRazorpaySecret()
      if (r.error) {
        setError(r.error)
        return
      }
      setKeySecret('')
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="mt-6 space-y-5">
      <div
        className={`flex items-start gap-3 rounded-md border px-3 py-3 text-sm ${
          hasSecret
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700'
            : 'border-amber-500/30 bg-amber-500/5 text-amber-700'
        }`}
      >
        {hasSecret ? (
          <ShieldCheck size={18} className="mt-0.5 shrink-0" />
        ) : (
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
        )}
        <div>
          <p className="font-medium">
            {hasSecret ? 'Secret configured ✓' : 'No key secret configured'}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {hasSecret
              ? 'Your key secret is stored encrypted and is never shown again. Enter a new one below to replace it.'
              : 'Online deposits stay unavailable until a Razorpay key ID and key secret are saved.'}
          </p>
        </div>
      </div>

      <Field
        id="razorpayKeyId"
        label="Razorpay Key ID"
        hint="Publishable — this is the id Razorpay Checkout uses in the customer's browser."
      >
        <input
          id="razorpayKeyId"
          value={keyId}
          onChange={(e) => {
            setKeyId(e.target.value)
            touch()
          }}
          disabled={pending}
          placeholder="rzp_test_XXXXXXXXXXXXXX"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className={`${input} font-mono`}
        />
        {keyIdError && <p className="mt-1 text-xs text-destructive">{keyIdError}</p>}
      </Field>

      <Field
        id="razorpayKeySecret"
        label="Razorpay Key Secret"
        hint={
          hasSecret
            ? 'Leave blank to keep the secret you already saved. Anything you type here replaces it.'
            : 'Stored encrypted with AES-256-GCM. It is never displayed again after saving.'
        }
      >
        <input
          id="razorpayKeySecret"
          type="password"
          value={keySecret}
          onChange={(e) => {
            setKeySecret(e.target.value)
            touch()
          }}
          disabled={pending}
          placeholder={hasSecret ? '•••••••••••••••• (unchanged)' : 'Paste your key secret'}
          autoComplete="new-password"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          className={`${input} font-mono`}
        />
      </Field>

      <div className="rounded-lg border border-border p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Webhook
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Register this URL on your Razorpay account for the{' '}
          <code className="rounded bg-muted px-1">payment.captured</code> event. Razorpay signs
          every delivery with the webhook secret below — that signature is the only thing that
          confirms a deposit, so a customer closing the payment window mid-flow can never mark a
          booking paid.
        </p>
        <code className="mt-2 block overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs">
          {webhookUrl}
        </code>

        <div className="mt-3">
          <Field
            id="razorpayWebhookSecret"
            label="Razorpay Webhook Secret"
            hint={
              hasWebhookSecret
                ? 'Configured ✓ — leave blank to keep it. This is a different credential from the key secret above.'
                : 'A separate credential from the key secret. Copy it from the webhook you create in the Razorpay dashboard.'
            }
          >
            <input
              id="razorpayWebhookSecret"
              type="password"
              value={webhookSecret}
              onChange={(e) => {
                setWebhookSecret(e.target.value)
                touch()
              }}
              disabled={pending}
              placeholder={hasWebhookSecret ? '•••••••••••••••• (unchanged)' : 'Paste your webhook secret'}
              autoComplete="new-password"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              className={`${input} font-mono`}
            />
          </Field>
        </div>

        {!hasWebhookSecret && (
          <p className="mt-2 text-xs text-amber-600">
            Without a webhook secret, deposits can be started but never confirmed.
          </p>
        )}
        {hasWebhookSecret && (
          <button
            onClick={removeWebhookSecret}
            disabled={pending}
            className="mt-2 text-xs font-medium text-destructive hover:underline disabled:opacity-50"
          >
            Remove webhook secret
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={submit}
          disabled={pending || Boolean(keyIdError)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <KeyRound size={15} />
          {pending ? 'Saving…' : 'Save credentials'}
        </button>
        {hasSecret && (
          <button
            onClick={removeSecret}
            disabled={pending}
            className="rounded-md border px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
          >
            Remove secret
          </button>
        )}
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>

      <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        The key secret is encrypted before it reaches the database, under a master key held only
        in the server environment. It is never sent back to this page, and staff below manager
        level cannot view or change these settings.
      </p>
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
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
