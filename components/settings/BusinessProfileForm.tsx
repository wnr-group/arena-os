'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Check, Loader2, Percent, ReceiptText, Star } from 'lucide-react'
import { saveBusinessProfile } from '@/lib/actions/business-profile'
import { DEFAULT_INVOICE_PREFIX, MAX_INVOICE_PREFIX_LENGTH } from '@/lib/settings/business-profile'
import {
  isWhatsappGroupUrl,
  WHATSAPP_GROUP_URL_MESSAGE,
  WHATSAPP_REDIRECT_SECONDS,
} from '@/lib/settings/whatsapp-group'
import { isGoogleReviewUrl, GOOGLE_REVIEW_URL_MESSAGE } from '@/lib/settings/google-review'

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
  serviceChargePercent: string
  serviceChargeTaxRateId: string
  whatsappGroupUrl: string
  whatsappGroupEnabled: boolean
  googleReviewUrl: string
  googleReviewEnabled: boolean
}

const input =
  'w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground/60 hover:border-foreground/30 focus:border-primary focus:ring-2 focus:ring-ring/30 disabled:opacity-60'

/** Settings form for the tenant's business profile (GST, invoice prefix, service charge, etc). */
export function BusinessProfileForm({
  initial,
  tenantName,
  configured,
  taxRates,
  isRestaurant,
}: {
  initial: Fields
  tenantName: string
  configured: boolean
  /** The tenant's own tax_rates (M18 #3) — the service charge's GST rate is
   *  picked from these, never free-typed, so it can't drift from a slab the
   *  tenant doesn't actually file under. */
  taxRates: { id: string; name: string; percent: string }[]
  /** M18 (split bill / service charge / tips) is restaurant-only — the
   *  service charge section below is hidden entirely for every other
   *  tenant type. The actual enforcement lives server-side
   *  (loadServiceChargeConfig always returns 0 for a non-restaurant
   *  tenant); this is just keeping a meaningless control off the screen. */
  isRestaurant: boolean
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

  const serviceChargePercent = Number(fields.serviceChargePercent || '0')
  const serviceChargeError =
    isRestaurant && (!Number.isFinite(serviceChargePercent) || serviceChargePercent < 0 || serviceChargePercent > 100)
      ? 'Enter a percentage between 0 and 100.'
      : null

  // The SAME predicate the action and the column CHECK use, so the field cannot
  // say "fine" about something the save will refuse.
  // Same three-state shape as the WhatsApp field below: blank+off is fine,
  // blank+on is refused, and a non-blank value must pass the SAME predicate
  // the save action and the column CHECK use.
  const googleUrl = fields.googleReviewUrl.trim()
  const googleError = !googleUrl
    ? fields.googleReviewEnabled
      ? 'Add a Google review link before turning the prompt on.'
      : null
    : isGoogleReviewUrl(googleUrl)
      ? null
      : GOOGLE_REVIEW_URL_MESSAGE

  const whatsappUrl = fields.whatsappGroupUrl.trim()
  const whatsappError = !whatsappUrl
    ? fields.whatsappGroupEnabled
      ? 'Add a WhatsApp group link before turning the invite on.'
      : null
    : isWhatsappGroupUrl(whatsappUrl)
      ? null
      : WHATSAPP_GROUP_URL_MESSAGE

  function submit() {
    if (pending || prefixError || serviceChargeError || whatsappError || googleError) return
    setError(null)
    start(async () => {
      const r = await saveBusinessProfile({
        ...fields,
        serviceChargePercent,
        serviceChargeTaxRateId: fields.serviceChargeTaxRateId || undefined,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="mt-8 space-y-6 pb-4">
      {!configured && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
          <Building2 size={18} className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
          <p>
            No profile configured yet — invoices currently print “{tenantName}” with no GSTIN. Fill this in to put
            your legal identity on every bill.
          </p>
        </div>
      )}

      <Section
        icon={<Building2 size={18} />}
        title="Business identity"
        description="Printed at the top of every GST invoice."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="legalName" label="Legal name" hint="The registered name printed at the top of the invoice.">
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
              className={`${input} font-mono tracking-wide`}
            />
          </Field>
        </div>

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

        <Field id="logoUrl" label="Logo URL" hint="Paste a link to your logo. Direct file upload arrives with the storage module.">
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
      </Section>

      <Section
        icon={<ReceiptText size={18} />}
        title="Invoicing"
        description="How your invoices are numbered and where they are taxed."
      >
        <div className="grid gap-5 sm:grid-cols-2">
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
              className={`${input} w-32 font-mono tracking-wider`}
            />
            {prefixError && <p className="mt-1.5 text-xs text-destructive">{prefixError}</p>}
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
        </div>
      </Section>

      {isRestaurant && (
        <Section
          icon={<Percent size={18} />}
          title="Service charge"
          description="Applied to every bill's subtotal, before GST. 0% leaves it off."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="serviceChargePercent" label="Percentage">
              <div className="relative">
                <input
                  id="serviceChargePercent"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  inputMode="decimal"
                  value={fields.serviceChargePercent}
                  onChange={(e) => set({ serviceChargePercent: e.target.value })}
                  disabled={pending}
                  placeholder="0.00"
                  className={`${input} pr-9`}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                  %
                </span>
              </div>
              {serviceChargeError && <p className="mt-1.5 text-xs text-destructive">{serviceChargeError}</p>}
            </Field>

            <Field
              id="serviceChargeTaxRateId"
              label="GST rate"
              hint="Picked from your own tax rates, not typed in — so it can never drift from a slab you actually file under."
            >
              <select
                id="serviceChargeTaxRateId"
                value={fields.serviceChargeTaxRateId}
                onChange={(e) => set({ serviceChargeTaxRateId: e.target.value })}
                disabled={pending}
                className={input}
              >
                <option value="">Not taxable</option>
                {taxRates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.percent}%)
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>
      )}

      <Section
        icon={<Star size={18} />}
        title="Customer engagement"
        description="Grow your reviews and your community straight from the booking journey."
      >
        <Feature
          icon={<Star size={16} />}
          tone="amber"
          title="Google review prompt"
          enabled={fields.googleReviewEnabled}
          onToggle={(v) => set({ googleReviewEnabled: v })}
          disabled={pending}
          toggleLabel="Ask customers to review us on Google"
        >
          <Field
            id="googleReviewUrl"
            label="Google review link"
            hint="Paste your Google review or Maps link. When this is on, customers who have had a session or an order are asked to rate you the next time they open their account."
          >
            <input
              id="googleReviewUrl"
              type="url"
              value={fields.googleReviewUrl}
              onChange={(e) => set({ googleReviewUrl: e.target.value })}
              disabled={pending}
              placeholder="https://g.page/r/AbC123DeF456/review"
              autoCorrect="off"
              spellCheck={false}
              className={input}
            />
            {googleError && <p className="mt-1.5 text-xs text-destructive">{googleError}</p>}
          </Field>
        </Feature>

        <Feature
          icon={<WhatsAppIcon size={16} />}
          tone="emerald"
          title="WhatsApp group invite"
          enabled={fields.whatsappGroupEnabled}
          onToggle={(v) => set({ whatsappGroupEnabled: v })}
          disabled={pending}
          toggleLabel="Show the group invite after a booking"
        >
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
            {whatsappError && <p className="mt-1.5 text-xs text-destructive">{whatsappError}</p>}
          </Field>
        </Feature>
      </Section>

      {error && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/90 px-4 py-3 shadow-lg backdrop-blur">
        <span className="text-sm text-muted-foreground">
          {saved && !pending ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <Check size={15} aria-hidden /> Saved
            </span>
          ) : (
            'Changes apply to new invoices and bookings.'
          )}
        </span>
        <button
          onClick={submit}
          disabled={pending || Boolean(prefixError) || Boolean(serviceChargeError) || Boolean(whatsappError) || Boolean(googleError)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:opacity-50"
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          {pending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  )
}

/** The WhatsApp brand mark (lucide has no brand icons). Inherits the current text colour. */
function WhatsAppIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  )
}

/** A titled card that groups related fields. Shared with GoogleBusinessForm. */
export function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-center gap-3 border-b border-border bg-muted/30 px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </header>
      <div className="space-y-5 p-5">{children}</div>
    </section>
  )
}

/** An optional feature: a header with an on/off switch above its fields. */
function Feature({
  icon,
  tone,
  title,
  enabled,
  onToggle,
  disabled,
  toggleLabel,
  children,
}: {
  icon: React.ReactNode
  tone: 'amber' | 'emerald'
  title: string
  enabled: boolean
  onToggle: (v: boolean) => void
  disabled: boolean
  toggleLabel: string
  children: React.ReactNode
}) {
  const badge = tone === 'amber' ? 'bg-amber-500/10 text-amber-500' : 'bg-emerald-500/10 text-emerald-500'
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${badge}`}>{icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">{title}</p>
            <p className="text-xs text-muted-foreground">{toggleLabel}</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={toggleLabel}
          disabled={disabled}
          onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
            enabled ? 'bg-primary' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <div className="mt-4">{children}</div>
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
