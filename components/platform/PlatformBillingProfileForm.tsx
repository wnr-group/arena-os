'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText } from 'lucide-react'
import { savePlatformBillingProfile } from '@/lib/actions/platform-gateway'

/**
 * Arena OS's own GST letterhead — who the SUPPLIER is on a subscription invoice
 * (M16 #4).
 *
 * Nothing here is secret, which is the whole difference between this form and
 * PlatformGatewayForm beside it: that one handles credentials and never shows
 * them again, this one shows everything it stores because a legal name and a
 * GSTIN are printed on every invoice anyway.
 *
 * What IS worth knowing: editing these values changes what FUTURE invoices say.
 * Invoices already raised carry their own snapshot of every field and are
 * unaffected — see lib/platform/billing/invoices.ts. The copy says so, because
 * an operator correcting a typo needs to know it will not retroactively fix
 * bills already filed with a customer.
 */

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
const label = 'text-xs font-medium text-muted-foreground'

export type PlatformBillingProfile = {
  sellerLegalName: string
  sellerGstin: string
  sellerAddress: string
  sellerStateCode: string
  gstRate: string
  invoicePrefix: string
  creditNotePrefix: string
}

export function PlatformBillingProfileForm({ profile }: { profile: PlatformBillingProfile }) {
  const router = useRouter()
  const [fields, setFields] = useState(profile)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function set(patch: Partial<PlatformBillingProfile>) {
    setFields((f) => ({ ...f, ...patch }))
    setSaved(false)
    setError(null)
  }

  function submit() {
    if (pending) return
    setError(null)
    start(async () => {
      const r = await savePlatformBillingProfile(fields)
      if (r.error) {
        setError(r.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <section className="mt-6 rounded-lg border">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <FileText size={15} className="text-primary" />
        Invoice letterhead
      </h2>

      <div className="space-y-4 p-4">
        <p className="text-xs text-muted-foreground">
          Printed on the GST invoices Arena OS issues to businesses. Changing these affects{' '}
          <strong>future</strong> invoices only — every invoice already raised carries its own
          copy of these values and will not change.
        </p>

        <div>
          <label className={label} htmlFor="pb-legal-name">
            Legal name
          </label>
          <input
            id="pb-legal-name"
            className={input}
            value={fields.sellerLegalName}
            onChange={(e) => set({ sellerLegalName: e.target.value })}
            placeholder="Arena OS Technologies Pvt Ltd"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="pb-gstin">
              GSTIN
            </label>
            <input
              id="pb-gstin"
              className={input}
              value={fields.sellerGstin}
              onChange={(e) => set({ sellerGstin: e.target.value.toUpperCase() })}
              placeholder="33AAAAA0000A1Z5"
              spellCheck={false}
            />
          </div>
          <div>
            <label className={label} htmlFor="pb-state">
              GST state code
            </label>
            <input
              id="pb-state"
              className={input}
              value={fields.sellerStateCode}
              onChange={(e) => set({ sellerStateCode: e.target.value })}
              placeholder="33"
              inputMode="numeric"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Decides CGST+SGST vs IGST. Taken from the GSTIN when left blank.
            </p>
          </div>
        </div>

        <div>
          <label className={label} htmlFor="pb-address">
            Registered address
          </label>
          <textarea
            id="pb-address"
            className={`${input} min-h-20`}
            value={fields.sellerAddress}
            onChange={(e) => set({ sellerAddress: e.target.value })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={label} htmlFor="pb-rate">
              GST rate %
            </label>
            <input
              id="pb-rate"
              className={input}
              value={fields.gstRate}
              onChange={(e) => set({ gstRate: e.target.value })}
              placeholder="18"
              inputMode="decimal"
            />
          </div>
          <div>
            <label className={label} htmlFor="pb-prefix">
              Invoice prefix
            </label>
            <input
              id="pb-prefix"
              className={input}
              value={fields.invoicePrefix}
              onChange={(e) => set({ invoicePrefix: e.target.value.toUpperCase() })}
              placeholder="AOS"
              maxLength={4}
            />
          </div>
          <div>
            <label className={label} htmlFor="pb-cn-prefix">
              Credit note prefix
            </label>
            <input
              id="pb-cn-prefix"
              className={input}
              value={fields.creditNotePrefix}
              onChange={(e) => set({ creditNotePrefix: e.target.value.toUpperCase() })}
              placeholder="AOC"
              maxLength={4}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Numbers run as <code>PREFIX/YYYY/NNNNNN</code> per financial year, the same format and
          16-character GST limit the venue-side invoice numbering uses.
        </p>

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

        <button
          type="button"
          disabled={pending}
          onClick={submit}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save letterhead'}
        </button>
      </div>
    </section>
  )
}
