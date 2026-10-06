'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatMoney } from '@/lib/format'
import type { PublicPlan, PublicEntitlementValue } from '@/lib/platform/plans/public'
import { Reveal } from '../ui/Reveal'
import { SectionHeading } from '../ui/SectionHeading'

/** Included on every plan — these are not plan-gated (only the module.* keys below are). */
const ALWAYS_INCLUDED = [
  'Bookings, walk-ins & GST invoicing',
  'Online storefront & website builder',
  'Kitchen, orders & table service',
  'Customers, memberships & loyalty',
]

const LIMITS: [string, string][] = [
  ['max_branches', 'branches'],
  ['max_staff', 'staff accounts'],
  ['max_resources', 'bookable resources'],
]

const MODULES: Record<string, string> = {
  'module.reports': 'Reports & analytics',
  'module.payroll': 'Payroll & payslips',
  'module.expenses': 'Expenses & P&L',
  'module.events': 'Tournaments & events',
}

/** Whole-rupee price for display ("₹2,999") — the plan cards don't need paise. */
function wholeMoney(amount: number, currency: string) {
  return formatMoney(Math.round(amount), currency).replace(/\.00$/, '')
}

function prettyKey(key: string) {
  const s = key.replace(/^module\./, '').replace(/[_.]/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A plan's entitlements as display rows. Unknown keys are shown, not dropped. */
function featureRows(ent: Record<string, PublicEntitlementValue>) {
  const rows: { label: string; on: boolean }[] = []
  for (const [key, noun] of LIMITS) {
    if (!(key in ent)) continue
    const v = ent[key]
    rows.push({ label: v === null ? `Unlimited ${noun}` : `Up to ${v} ${noun}`, on: true })
  }
  for (const [key, value] of Object.entries(ent)) {
    if (!key.startsWith('module.') && !(key in MODULES)) continue
    if (typeof value !== 'boolean') continue
    rows.push({ label: MODULES[key] ?? prettyKey(key), on: value })
  }
  return rows
}

export function PricingSection({ plans }: { plans: PublicPlan[] }) {
  const [annual, setAnnual] = useState(false)

  const popularId =
    plans.find((p) => p.name.toLowerCase() === 'pro')?.id ?? (plans.length === 3 ? plans[1].id : null)

  const maxSaving = Math.max(
    0,
    ...plans.map((p) => {
      const m = Number(p.monthlyPrice) * 12
      return m > 0 ? Math.round((1 - Number(p.annualPrice) / m) * 100) : 0
    }),
  )

  return (
    <section id="pricing" className="scroll-mt-16 bg-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Pricing"
          title={
            <>
              Simple plans that <span className="mk-gradient-text">grow with you.</span>
            </>
          }
          subtitle="Pick a plan, claim your subdomain and start taking bookings."
        />

        {plans.length > 0 && (
          <Reveal delay={200}>
            <div className="mt-10 flex items-center justify-center">
              <div
                role="group"
                aria-label="Billing period"
                className="relative inline-grid grid-cols-2 rounded-full border border-border-strong bg-card p-1 text-sm font-semibold shadow-sm"
              >
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-y-1 w-[calc(50%-0.25rem)] rounded-full bg-primary shadow transition-transform duration-300 ease-out',
                    annual ? 'translate-x-full' : 'translate-x-0',
                  )}
                />
                {[
                  { label: 'Monthly', value: false },
                  { label: 'Yearly', value: true },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    aria-pressed={annual === o.value}
                    onClick={() => setAnnual(o.value)}
                    className={cn(
                      'relative z-10 rounded-full px-6 py-2 transition-colors',
                      annual === o.value ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {o.label}
                    {o.value && maxSaving > 0 && (
                      <span
                        className={cn(
                          'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                          annual ? 'bg-white/20 text-white' : 'bg-mint-bg text-mint',
                        )}
                      >
                        Save {maxSaving}%
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </Reveal>
        )}

        {plans.length === 0 ? (
          <Reveal>
            <div className="mx-auto mt-12 max-w-md rounded-2xl border border-border-strong bg-card p-8 text-center shadow-sm">
              <p className="font-semibold">Plans are being finalised.</p>
              <p className="mt-1 text-sm text-muted-foreground">Create your workspace and pick a plan when you&apos;re ready.</p>
              <Link
                href="/signup"
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition hover:bg-primary-hover"
              >
                Get started <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        ) : (
          <div className="mx-auto mt-12 grid max-w-6xl items-stretch gap-6 md:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan, i) => {
              const popular = plan.id === popularId
              const monthly = Number(plan.monthlyPrice)
              const yearly = Number(plan.annualPrice)
              const shown = annual ? yearly / 12 : monthly
              const rows = featureRows(plan.entitlements)

              return (
                <Reveal key={plan.id} delay={i * 110} className="h-full">
                  <div
                    className={cn(
                      'relative flex h-full flex-col rounded-3xl border p-7 transition duration-300 hover:-translate-y-1',
                      popular
                        ? 'mk-dark border-transparent shadow-2xl shadow-primary/30 lg:scale-[1.04]'
                        : 'border-border-strong bg-card shadow-sm hover:shadow-xl hover:shadow-primary/10',
                    )}
                  >
                    {popular && (
                      <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-[#d49a3a] to-[#e3b565] px-4 py-1 text-xs font-extrabold uppercase tracking-wide text-[#34122a] shadow">
                        Most popular
                      </span>
                    )}
                    <h3 className="text-lg font-bold">{plan.name}</h3>
                    <div className="mt-4 flex items-baseline gap-1">
                      <span className="text-3xl font-extrabold tracking-tight">{wholeMoney(shown, plan.currency)}</span>
                      <span className={cn('text-sm', popular ? 'text-white/60' : 'text-muted-foreground')}>/mo</span>
                    </div>
                    <p className={cn('mt-1 h-5 text-xs', popular ? 'text-white/60' : 'text-muted-foreground')}>
                      {annual ? `Billed ${wholeMoney(yearly, plan.currency)} yearly` : 'Billed monthly'}
                    </p>

                    <Link
                      href="/signup"
                      className={cn(
                        'mk-shine group mt-6 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold transition',
                        popular
                          ? 'bg-white text-primary shadow-lg hover:bg-white/90'
                          : 'bg-primary text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary-hover',
                      )}
                    >
                      Get started
                      <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
                    </Link>

                    <ul className="mt-7 space-y-3 text-sm">
                      {rows.map((r) => (
                        <li
                          key={r.label}
                          className={cn(
                            'flex items-start gap-2.5',
                            !r.on && (popular ? 'text-white/40' : 'text-subtle-foreground'),
                          )}
                        >
                          {r.on ? (
                            <Check size={16} strokeWidth={3} className={popular ? 'mt-0.5 text-[#e3b565]' : 'mt-0.5 text-primary'} />
                          ) : (
                            <Minus size={16} className="mt-0.5" />
                          )}
                          <span className={r.on ? 'font-medium' : 'line-through'}>{r.label}</span>
                        </li>
                      ))}
                      <li className={cn('my-2 border-t', popular ? 'border-white/15' : 'border-border')} aria-hidden />
                      {ALWAYS_INCLUDED.map((label) => (
                        <li key={label} className={cn('flex items-start gap-2.5', popular ? 'text-white/80' : 'text-muted-foreground')}>
                          <Check size={16} strokeWidth={3} className={popular ? 'mt-0.5 text-white/60' : 'mt-0.5 text-mint'} />
                          {label}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Reveal>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
