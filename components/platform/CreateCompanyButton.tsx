'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'
import { createCompany } from '@/lib/actions/platform'

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const label = 'text-xs font-medium text-muted-foreground'

const INDUSTRIES = [
  ['gaming_cafe', 'Gaming Cafe'],
  ['recording_studio', 'Recording Studio'],
  ['podcast_studio', 'Podcast Studio'],
  ['dance_studio', 'Dance Studio'],
  ['vr_centre', 'VR Centre'],
  ['restaurant', 'Restaurant'],
  ['other', 'Other'],
] as const

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

/**
 * The sellable plans, passed in from the server (active only — a retired plan
 * exists for grandfathering and must never start a new company).
 */
export type CreatablePlan = { id: string; name: string; monthlyPrice: string; annualPrice: string; currency: string }

export function CreateCompanyButton({ plans }: { plans: CreatablePlan[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [industry, setIndustry] = useState<string>('gaming_cafe')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  // Defaulted to the first plan rather than left blank: the catalogue is
  // ordered and the operator is picking a tier, not opting in to having one.
  const [planId, setPlanId] = useState<string>(plans[0]?.id ?? '')
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'annual'>('monthly')

  function submit() {
    setError(null)
    setWarning(null)
    start(async () => {
      const r = await createCompany({
        companyName: name,
        slug,
        industry: industry as (typeof INDUSTRIES)[number][0],
        ownerName,
        ownerEmail,
        ownerPassword,
        planId,
        billingPeriod,
      })
      if (r.error) setError(r.error)
      // Created, but WITHOUT the plan. Not an error — the company is real and
      // its owner can sign in — so it must not read as one. It must not close
      // the dialog either: this is the one outcome that needs the operator to
      // go and finish something, and a dialog that vanished would be the last
      // they heard of it. The list still refreshes, because the company is there.
      else if (r.warning) {
        setWarning(r.warning)
        router.refresh()
      } else {
        setOpen(false)
        setName('')
        setSlug('')
        setSlugEdited(false)
        setOwnerName('')
        setOwnerEmail('')
        setOwnerPassword('')
        router.refresh()
      }
    })
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        <Plus size={16} /> New company
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">New company</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Company name</label>
                  <input
                    className={input}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      if (!slugEdited) setSlug(slugify(e.target.value))
                    }}
                  />
                </div>
                <div>
                  <label className={label}>Industry</label>
                  <select className={input} value={industry} onChange={(e) => setIndustry(e.target.value)}>
                    {INDUSTRIES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className={label}>Subdomain</label>
                <div className="flex items-center gap-2">
                  <input
                    className={input}
                    value={slug}
                    onChange={(e) => {
                      setSlugEdited(true)
                      setSlug(slugify(e.target.value))
                    }}
                    placeholder="acme"
                  />
                  <span className="whitespace-nowrap text-sm text-muted-foreground">.arenaos.app</span>
                </div>
              </div>

              <div className="rounded-md border border-dashed p-3">
                <p className="text-xs font-medium text-muted-foreground">First owner account</p>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Owner name</label>
                    <input className={input} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
                  </div>
                  <div>
                    <label className={label}>Owner email</label>
                    <input className={input} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
                  </div>
                </div>
                <div className="mt-3">
                  <label className={label}>Temporary password</label>
                  <input className={input} type="text" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} placeholder="min 8 characters" />
                </div>
              </div>

              {/*
                The plan is part of creating a company, not an afterthought.
                A company with no plan opens with payroll, expenses and every
                report refused and its staff and resources capped, because the
                M16 entitlement gates are fail-closed — so there is deliberately
                no "assign later" option here.
              */}
              <div className="rounded-md border border-dashed p-3">
                <p className="text-xs font-medium text-muted-foreground">Subscription</p>
                {plans.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    There are no live plans yet. Create one under{' '}
                    <a href="/admin/plans" className="font-medium underline">
                      Plans
                    </a>{' '}
                    first — a company created without one cannot use payroll, expenses or reports.
                  </p>
                ) : (
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <div>
                      <label className={label}>Plan</label>
                      <select className={input} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                        {plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={label}>Billing period</label>
                      <select
                        className={input}
                        value={billingPeriod}
                        onChange={(e) => setBillingPeriod(e.target.value as 'monthly' | 'annual')}
                      >
                        <option value="monthly">Monthly</option>
                        <option value="annual">Annual</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {warning && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm text-amber-700 dark:text-amber-400">
                  {warning}
                </p>
              )}

              <button
                onClick={submit}
                disabled={pending || !name || !slug || !ownerEmail || !ownerName || ownerPassword.length < 8 || !planId}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 size={15} className="animate-spin" />}
                {pending ? 'Creating…' : 'Create company'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
