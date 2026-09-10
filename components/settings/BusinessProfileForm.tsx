'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { saveBusinessProfile } from '@/lib/actions/business-profile'
import { DEFAULT_INVOICE_PREFIX, MAX_INVOICE_PREFIX_LENGTH } from '@/lib/settings/business-profile'
import {
  isWhatsappGroupUrl,
  WHATSAPP_GROUP_URL_MESSAGE,
  WHATSAPP_REDIRECT_SECONDS,
} from '@/lib/settings/whatsapp-group'

/**
 * Owner-only business profile form.
 *
 * Same shape as WorkingHoursForm: local state, useTransition, a single server
 * action, then router.refresh(). The action re-checks the owner role and the
 * database enforces it again through the business_write policy.
 */

type Fields = {
  legalName: string
  gstin: string
  address: string
  logoUrl: string
  invoicePrefix: string
  placeOfSupply: string
  whatsappGroupUrl: string
  whatsappGroupEnabled: boolean
}

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'

export function BusinessProfileForm({
  initial,
  tenantName,
  configured,
}: {
  initial: Fields
  tenantName: string
  configured: boolean
}) {
  const router = useRouter()
  const [fields, setFields] = useState<Fields>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function set(patch: Partial<Fields>) {
    setFields((f) => ({ ...f, ...patch }))
    setSaved(false)
    setError(null)
  }

  const prefix = fields.invoicePrefix.trim()
  const prefixError = !prefix
    ? 'An invoice prefix is required.'
    : prefix.length > MAX_INVOICE_PREFIX_LENGTH
      ? `Keep it to ${MAX_INVOICE_PREFIX_LENGTH} characters.`
      : null

  // The SAME predicate the action and the column CHECK use, so the field cannot
  // say "fine" about something the save will refuse.
  const whatsappUrl = fields.whatsappGroupUrl.trim()
  const whatsappError = !whatsappUrl
    ? fields.whatsappGroupEnabled
      ? 'Add a WhatsApp group link before turning the invite on.'
      : null
    : isWhatsappGroupUrl(whatsappUrl)
      ? null
      : WHATSAPP_GROUP_URL_MESSAGE

  function submit() {
    if (pending || prefixError || whatsappError) return
    setError(null)
    start(async () => {
      const r = await saveBusinessProfile(fields)
      if (r.error) {
        setError(r.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="mt-6 space-y-5">
      {!configured && (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          No profile configured yet — invoices currently print “{tenantName}” with no
          GSTIN. Fill this in to put your legal identity on every bill.
        </p>
      )}

      <Field
        id="legalName"
        label="Legal name"
        hint="The registered name printed at the top of the invoice."
      >
        <input
          id="legalName"
          value={fields.legalName}
          onChange={(e) => set({ legalName: e.target.value })}
          disabled={pending}
          placeholder={tenantName}
          className={input}
        />
      </Field>

      <Field id="gstin" label="GSTIN" hint="Leave blank if you are not GST-registered.">
        <input
          id="gstin"
          value={fields.gstin}
          onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
          disabled={pending}
          placeholder="33AAAAA0000A1Z5"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className={input}
        />
      </Field>

      <Field id="address" label="Address" hint="Printed under the legal name.">
        <textarea
          id="address"
          value={fields.address}
          onChange={(e) => set({ address: e.target.value })}
          disabled={pending}
          rows={3}
          placeholder="12 Anna Salai&#10;Chennai 600002"
          className={`${input} resize-y`}
        />
      </Field>

      <Field
        id="invoicePrefix"
        label="Invoice prefix"
        hint={`Numbers are issued as ${prefix || DEFAULT_INVOICE_PREFIX}/2627/000001. Max ${MAX_INVOICE_PREFIX_LENGTH} characters — a GST invoice number cannot exceed 16.`}
      >
        <input
          id="invoicePrefix"
          value={fields.invoicePrefix}
          onChange={(e) => set({ invoicePrefix: e.target.value.toUpperCase() })}
          disabled={pending}
          maxLength={MAX_INVOICE_PREFIX_LENGTH}
          placeholder={DEFAULT_INVOICE_PREFIX}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className={`${input} w-32`}
        />
        {prefixError && <p className="mt-1 text-xs text-destructive">{prefixError}</p>}
      </Field>

      <Field
        id="placeOfSupply"
        label="Place of supply"
        hint="Your GST state. Snapshotted onto each invoice when it is raised."
      >
        <input
          id="placeOfSupply"
          value={fields.placeOfSupply}
          onChange={(e) => set({ placeOfSupply: e.target.value })}
          disabled={pending}
          placeholder="Tamil Nadu"
          className={input}
        />
      </Field>

      <Field
        id="whatsappGroupUrl"
        label="WhatsApp group invite"
        hint={`Paste your group's invite link. When this is on, customers see a "Join WhatsApp Group" button on their booking confirmation and are taken there automatically after ${WHATSAPP_REDIRECT_SECONDS} seconds. Leave it off to change nothing about the booking page.`}
      >
        <input
          id="whatsappGroupUrl"
          type="url"
          value={fields.whatsappGroupUrl}
          onChange={(e) => set({ whatsappGroupUrl: e.target.value })}
          disabled={pending}
          placeholder="https://chat.whatsapp.com/AbC123DeF456"
          autoCorrect="off"
          spellCheck={false}
          className={input}
        />
        <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={fields.whatsappGroupEnabled}
            onChange={(e) => set({ whatsappGroupEnabled: e.target.checked })}
            disabled={pending}
            className="size-4 rounded border-input accent-primary"
          />
          Show the group invite after a booking
        </label>
        {whatsappError && <p className="mt-1 text-xs text-destructive">{whatsappError}</p>}
      </Field>

      <Field
        id="logoUrl"
        label="Logo URL"
        hint="Paste a link to your logo. Direct file upload arrives with the storage module."
      >
        <input
          id="logoUrl"
          type="url"
          value={fields.logoUrl}
          onChange={(e) => set({ logoUrl: e.target.value })}
          disabled={pending}
          placeholder="https://…/logo.png"
          className={input}
        />
      </Field>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending || Boolean(prefixError) || Boolean(whatsappError)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          {pending ? 'Saving…' : 'Save profile'}
        </button>
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
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
