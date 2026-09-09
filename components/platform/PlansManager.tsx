'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Infinity as InfinityIcon, Link2, Pencil, Plus, Power, Trash2, X } from 'lucide-react'
import {
  createPlan,
  updatePlan,
  setPlanActive,
  setPlanEntitlement,
  removePlanEntitlement,
  setPlanGateway,
} from '@/lib/actions/plans'
import { KNOWN_ENTITLEMENT_KEYS } from '@/lib/platform/plans/defaults'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { money } from '@/lib/format'

/**
 * Platform-admin management for the plan catalogue and its entitlements (M16).
 *
 * Same shape as CompanyManager: a client component over the server actions in
 * lib/actions/plans.ts, which are the security boundary — every one of them
 * calls requirePlatformAdmin() itself, so nothing here is trusted.
 *
 * The entitlement editor is deliberately GENERIC. `KNOWN_ENTITLEMENT_KEYS` fills
 * a datalist as a typing convenience and nothing more: the key field is free
 * text, so an operator can add a key this build has never heard of, and
 * getEntitlements() will return it without a deploy. Nothing here maps a key to
 * a feature — that is the enforcement story's job.
 */

type Entitlement = { id: string; key: string; value: unknown }
type Plan = {
  id: string
  name: string
  monthlyPrice: string
  annualPrice: string
  currency: string
  active: boolean
  /**
   * The Razorpay Subscription plans backing each billing period (M16 #3).
   * PUBLIC references, not credentials — a plan id appears in the checkout
   * page Razorpay serves the payer. Every secret lives in the platform
   * gateway settings, which no component ever receives.
   *
   * `plans.gateway` itself is deliberately NOT declared here: this component
   * never reads it, and a field in a client component's prop type is a field
   * that gets serialised into the RSC payload for every plan.
   */
  gatewayMonthlyPlanId: string | null
  gatewayAnnualPlanId: string | null
  subscriberCount: number
  entitlements: Entitlement[]
}

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const label = 'text-xs font-medium text-muted-foreground'

/** How a stored jsonb scalar reads in the table. null is the "unlimited" case. */
function displayValue(v: unknown): string {
  if (v === null) return 'Unlimited'
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  return String(v)
}


/**
 * What the annual price saves against paying monthly for a year.
 *
 * Worth showing because it is the one number nobody can eyeball: 79990 against
 * 7999×12 is a 17% discount, and a plan where the annual price is HIGHER than
 * twelve months is a pricing mistake this makes visible instead of leaving it
 * to be discovered by a customer. Null when it cannot be stated honestly —
 * either price missing, or no discount.
 */
function annualSaving(monthly: string, annual: string): number | null {
  const m = Number(monthly)
  const a = Number(annual)
  if (!Number.isFinite(m) || !Number.isFinite(a) || m <= 0 || a <= 0) return null
  const pct = Math.round((1 - a / (m * 12)) * 100)
  return pct === 0 ? null : pct
}

/** Which Razorpay periods a business can actually buy. */
function gatewayState(plan: Plan): { label: string; tone: 'ok' | 'partial' | 'none' } {
  const m = Boolean(plan.gatewayMonthlyPlanId)
  const a = Boolean(plan.gatewayAnnualPlanId)
  if (m && a) return { label: 'Monthly + annual', tone: 'ok' }
  if (m) return { label: 'Monthly only', tone: 'partial' }
  if (a) return { label: 'Annual only', tone: 'partial' }
  return { label: 'Not linked', tone: 'none' }
}

const BADGE_TONE = {
  ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  partial: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  none: 'bg-muted text-muted-foreground',
  brand: 'bg-primary/10 text-primary',
} as const

function Badge({
  tone,
  children,
}: {
  tone: keyof typeof BADGE_TONE
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  )
}

/**
 * One entitlement, rendered by KIND rather than as a bare string.
 *
 * A module flag and a numeric limit are different things and used to look
 * identical — "On" and "25" in the same column, in the same weight. A reader
 * scanning a plan wants "what does it include" and "how much of it", so the
 * boolean gets an on/off pill and the number stays numeric and right-aligned.
 * `Unlimited` is given the ∞ it means, since that is the value most likely to
 * be misread as "nothing set" — which is its exact opposite (see
 * lib/platform/entitlement-guard.ts: a MISSING key is a denial).
 */
function EntitlementValue({ value }: { value: unknown }) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-1 text-primary" title="Unlimited">
        <InfinityIcon size={14} aria-hidden />
        <span className="sr-only">Unlimited</span>
      </span>
    )
  }
  if (typeof value === 'boolean') {
    return <Badge tone={value ? 'ok' : 'none'}>{value ? 'On' : 'Off'}</Badge>
  }
  return <span className="tabular-nums">{displayValue(value)}</span>
}

/** Turn what was typed into the tagged union lib/actions/plans.ts expects. */
function parseValue(raw: string):
  | { type: 'number'; number: number }
  | { type: 'boolean'; boolean: boolean }
  | { type: 'string'; string: string }
  | { type: 'unlimited' }
  | null {
  const s = raw.trim()
  if (s === '') return null
  const lower = s.toLowerCase()
  if (lower === 'unlimited' || lower === 'null') return { type: 'unlimited' }
  if (lower === 'true' || lower === 'on') return { type: 'boolean', boolean: true }
  if (lower === 'false' || lower === 'off') return { type: 'boolean', boolean: false }
  if (/^-?\d+(\.\d+)?$/.test(s)) return { type: 'number', number: Number(s) }
  return { type: 'string', string: s }
}

export function PlansManager({ plans }: { plans: Plan[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [name, setName] = useState('')
  const [monthly, setMonthly] = useState('')
  const [annual, setAnnual] = useState('')

  function run(fn: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) {
        setError(r.error)
        return
      }
      after?.()
      router.refresh()
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {plans.length} plan{plans.length === 1 ? '' : 's'} · what businesses pay Arena OS.
            Entitlements are data — add any key you like.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((c) => !c)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {creating ? <X size={15} /> : <Plus size={15} />}
          {creating ? 'Cancel' : 'New plan'}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {creating && (
        <div className="mt-4 rounded-lg border p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={label} htmlFor="plan-name">Name</label>
              <input id="plan-name" className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro" />
            </div>
            <div>
              <label className={label} htmlFor="plan-monthly">Monthly price</label>
              <input id="plan-monthly" className={input} value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="7999" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="plan-annual">Annual price</label>
              <input id="plan-annual" className={input} value={annual} onChange={(e) => setAnnual(e.target.value)} placeholder="79990" inputMode="decimal" />
            </div>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => createPlan({ name, monthlyPrice: monthly, annualPrice: annual }),
                () => {
                  setCreating(false)
                  setName('')
                  setMonthly('')
                  setAnnual('')
                },
              )
            }
            className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create plan'}
          </button>
        </div>
      )}

      <div className="mt-6 space-y-4">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            pending={pending}
            onSave={(v) => run(() => updatePlan(plan.id, v))}
            onToggleActive={() =>
              run(async () => {
                if (plan.active && plan.subscriberCount > 0) {
                  const ok = await confirm({
                    title: `Retire ${plan.name}?`,
                    description: `${plan.subscriberCount} subscription${plan.subscriberCount === 1 ? '' : 's'} reference this plan. They keep everything it grants; it just stops being offered to new businesses.`,
                    confirmText: 'Retire plan',
                    // Not a deletion — the plan and every subscription on it survive.
                    variant: 'default',
                  })
                  if (!ok) return {}
                }
                return setPlanActive(plan.id, !plan.active)
              })
            }
            onSetEntitlement={(key, raw) => {
              const value = parseValue(raw)
              if (!value) {
                setError('Enter a value: a number, true/false, or "unlimited".')
                return
              }
              run(() => setPlanEntitlement({ planId: plan.id, key, value }))
            }}
            onRemoveEntitlement={(id) => run(() => removePlanEntitlement(id))}
            onSaveGateway={(v) => run(() => setPlanGateway(plan.id, v))}
          />
        ))}
      </div>

      <PlanComparison plans={plans} />

      <datalist id="entitlement-keys">
        {KNOWN_ENTITLEMENT_KEYS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  )
}

/**
 * Every plan's entitlements side by side.
 *
 * The question a catalogue page exists to answer is "how do these plans
 * differ", and a vertical stack of cards is the one layout that cannot answer
 * it — you have to hold Starter's max_staff in your head while scrolling to
 * Pro's. A matrix answers it by looking.
 *
 * It is also the only view that surfaces a GAP: a key present on two plans and
 * missing from a third shows as an empty cell, and a missing key is a denial
 * (lib/platform/entitlement-guard.ts), not a zero and not an inheritance. That
 * distinction is invisible on the cards above and is exactly the kind of
 * mis-priced plan that reaches a customer.
 *
 * Read-only on purpose: editing stays on the card that owns the plan, so there
 * is one place a value can be changed and no second copy of the write path.
 */
/** Past this many columns the table stops being comparable and starts being a spreadsheet. */
const COMPARE_LIMIT = 6

function PlanComparison({ plans }: { plans: Plan[] }) {
  /**
   * ACTIVE plans only, and at most COMPARE_LIMIT of them.
   *
   * Comparing everything was the first instinct and it was wrong twice over. A
   * retired plan is not on sale, so it cannot be chosen between — it belongs on
   * its own card, where it still says what it grants to the businesses
   * grandfathered onto it. And a table is only a comparison while the eye can
   * cross it: this database has fourteen plans, which rendered a 15-column grid
   * 1377px wide that pushed the whole PAGE into horizontal scroll, so the plan
   * cards above went off-screen too.
   */
  const candidates = plans
    // A plan granting nothing by name contributes a column of empty cells and
    // pushes a real one out. It is not hidden — its card says so plainly.
    .filter((p) => p.active && p.entitlements.length > 0)
    // Cheapest first, which is the order a price ladder is read in and the
    // order that makes "what does the next tier add" answerable by scanning
    // left to right. Taking them in list order put whichever plans happened to
    // be created first in the table, which is not a meaningful ordering.
    .sort((a, b) => Number(a.monthlyPrice) - Number(b.monthlyPrice))

  const shown = candidates.slice(0, COMPARE_LIMIT)
  const hidden = candidates.length - shown.length

  // Nothing to compare against a single plan; the card already says it all.
  if (shown.length < 2) return null

  // The union of every key any shown plan grants, so a key one plan omits still
  // gets a row — that hole is the point of the table.
  const keys = Array.from(new Set(shown.flatMap((p) => p.entitlements.map((e) => e.key)))).sort()
  if (keys.length === 0) return null

  const valueFor = (plan: Plan, key: string) => plan.entitlements.find((e) => e.key === key)

  return (
    <section className="mt-8 overflow-hidden rounded-lg border bg-card">
      <h2 className="border-b px-4 py-3 text-sm font-semibold">
        Compare plans
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          Active plans only. An empty cell means the key is absent — which denies the feature,
          rather than granting zero of it.
        </span>
      </h2>
      {/* min-w-full, not w-full: `w-full` sets width:100% and a table whose
          min-content is wider simply overflows its parent, which is what put
          this page into horizontal scroll. `min-w-full` lets the table exceed
          the container so the wrapper's overflow-x actually has something to
          scroll. */}
      <div className="w-full overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Entitlement</th>
              {shown.map((p) => (
                <th key={p.id} className="whitespace-nowrap px-4 py-2 text-right font-medium">
                  {p.name}
                  <span className="block font-normal tabular-nums">
                    {money(p.currency, p.monthlyPrice)}/mo
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {keys.map((key) => (
              <tr key={key}>
                <td className="px-4 py-2 font-mono text-xs">{key}</td>
                {shown.map((p) => {
                  const e = valueFor(p, key)
                  return (
                    <td key={p.id} className="px-4 py-2 text-right">
                      {e ? (
                        <EntitlementValue value={e.value} />
                      ) : (
                        <span className="text-muted-foreground/40" title="Not set — denied">
                          —
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {hidden} more active plan{hidden === 1 ? '' : 's'} not shown — a comparison stops being
          readable past {COMPARE_LIMIT} columns. Each one&rsquo;s entitlements are on its card above.
        </p>
      )}
    </section>
  )
}

function PlanCard({
  plan,
  pending,
  onSave,
  onToggleActive,
  onSetEntitlement,
  onRemoveEntitlement,
  onSaveGateway,
}: {
  plan: Plan
  pending: boolean
  onSave: (v: { name: string; monthlyPrice: string; annualPrice: string }) => void
  onToggleActive: () => void
  onSetEntitlement: (key: string, raw: string) => void
  onRemoveEntitlement: (id: string) => void
  onSaveGateway: (v: { gatewayMonthlyPlanId: string; gatewayAnnualPlanId: string }) => void
}) {
  const [name, setName] = useState(plan.name)
  const [monthly, setMonthly] = useState(plan.monthlyPrice)
  const [annual, setAnnual] = useState(plan.annualPrice)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [gwMonthly, setGwMonthly] = useState(plan.gatewayMonthlyPlanId ?? '')
  const [gwAnnual, setGwAnnual] = useState(plan.gatewayAnnualPlanId ?? '')
  /** Price/name editing is opt-in; the card reads as a summary until it is not. */
  const [editing, setEditing] = useState(false)

  const gatewayDirty =
    gwMonthly !== (plan.gatewayMonthlyPlanId ?? '') ||
    gwAnnual !== (plan.gatewayAnnualPlanId ?? '')

  const dirty =
    name !== plan.name || monthly !== plan.monthlyPrice || annual !== plan.annualPrice

  const gw = gatewayState(plan)
  const saving = annualSaving(plan.monthlyPrice, plan.annualPrice)

  return (
    <section
      className={
        plan.active
          ? 'overflow-hidden rounded-lg border bg-card'
          : 'overflow-hidden rounded-lg border border-dashed bg-muted/30'
      }
    >
      {/* ── the summary: what this plan IS, before any input ───────────────
          This used to open straight into three text boxes, so an operator
          checking a price had to read it out of an <input>, and a page of five
          plans was fifteen. Editing is now behind a toggle and the default view
          answers the questions actually being asked: what does it cost, can it
          be bought, and how many businesses are on it. */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold">{plan.name}</h3>
            {plan.active ? (
              <Badge tone="ok">Active</Badge>
            ) : (
              <Badge tone="none">Retired</Badge>
            )}
            <Badge tone={gw.tone}>
              <Link2 size={11} aria-hidden />
              {gw.label}
            </Badge>
          </div>

          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="text-lg font-semibold tabular-nums">
              {money(plan.currency, plan.monthlyPrice)}
            </span>
            <span className="text-muted-foreground">/month</span>
            <span className="text-border">·</span>
            <span className="font-medium tabular-nums">
              {money(plan.currency, plan.annualPrice)}
            </span>
            <span className="text-muted-foreground">/year</span>
            {saving !== null &&
              (saving > 0 ? (
                <Badge tone="ok">save {saving}%</Badge>
              ) : (
                // A negative "saving" means the annual price exceeds twelve
                // months. Almost certainly a typo, and silence would let it
                // reach a customer.
                <Badge tone="partial">{Math.abs(saving)}% MORE than monthly</Badge>
              ))}
          </p>

          <p className="mt-1 text-xs text-muted-foreground">
            {plan.subscriberCount} subscription{plan.subscriberCount === 1 ? '' : 's'} ·{' '}
            {plan.entitlements.length} entitlement{plan.entitlements.length === 1 ? '' : 's'} ·{' '}
            {plan.currency}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted"
          >
            {editing ? <X size={15} /> : <Pencil size={15} />}
            {editing ? 'Close' : 'Edit'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onToggleActive}
            title={plan.active ? 'Retire this plan' : 'Reinstate this plan'}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
          >
            <Power size={15} /> {plan.active ? 'Retire' : 'Reinstate'}
          </button>
        </div>
      </header>

      {editing && (
        <div className="flex flex-wrap items-end gap-3 border-b bg-muted/40 p-4">
          <div className="min-w-[10rem] flex-1">
            <label className={label}>Name</label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="w-32">
            <label className={label}>Monthly</label>
            <input className={input} value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" />
          </div>
          <div className="w-32">
            <label className={label}>Annual</label>
            <input className={input} value={annual} onChange={(e) => setAnnual(e.target.value)} inputMode="decimal" />
          </div>
          <button
            type="button"
            disabled={pending || !dirty}
            onClick={() => onSave({ name, monthlyPrice: monthly, annualPrice: annual })}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            <Check size={15} /> Save
          </button>
        </div>
      )}

      <div className="p-4">
        <table className="w-full text-sm">
          <tbody>
            {plan.entitlements.length === 0 ? (
              <tr>
                <td className="py-2 text-sm text-muted-foreground">
                  No entitlements yet — this plan grants nothing by name.
                </td>
              </tr>
            ) : (
              plan.entitlements.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="py-1.5 font-mono text-xs">{e.key}</td>
                  <td className="py-1.5 text-right">
                    <EntitlementValue value={e.value} />
                  </td>
                  <td className="w-8 py-1.5 text-right">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onRemoveEntitlement(e.id)}
                      aria-label={`Remove ${e.key}`}
                      className="rounded p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Everything below is an EDITOR, and editors are opt-in.
            Leaving the key/value adder and the Razorpay panel permanently open
            put four inputs on every card — on a catalogue of fourteen plans
            that is fifty-six, all of them empty, all of them competing with the
            prices somebody actually came to read. They appear on Edit, beside
            the name and price fields, which is where changing a plan belongs. */}
        {editing && (
        <>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label className={label}>Key</label>
            <input
              className={input}
              list="entitlement-keys"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="max_branches"
            />
          </div>
          <div className="w-40">
            <label className={label}>Value</label>
            <input
              className={input}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="3 · true · unlimited"
            />
          </div>
          <button
            type="button"
            disabled={pending || !newKey.trim()}
            onClick={() => {
              onSetEntitlement(newKey, newValue)
              setNewKey('')
              setNewValue('')
            }}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
          >
            <Plus size={15} /> Set
          </button>
        </div>

        {/*
          The Arena OS plan → Razorpay Subscription plan mapping (M16 #3).

          Two ids, not one, because monthly_price and annual_price are two
          different prices and a Razorpay plan object carries its own amount.
          Leaving one blank means that billing period simply cannot be bought —
          the checkout refuses it outright rather than falling back to the other,
          which is what makes "accidentally billed annually" impossible.

          These are PUBLIC references. No credential is ever rendered here; the
          platform key and webhook secrets live at /admin/billing and are never
          returned to a browser at all.
        */}
        <div className="mt-5 rounded-md border border-dashed p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Link2 size={13} className="text-primary" />
            Razorpay Subscription plans
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <label className={label}>Monthly plan ID</label>
              <input
                className={input}
                value={gwMonthly}
                onChange={(e) => setGwMonthly(e.target.value)}
                placeholder="plan_…"
                spellCheck={false}
              />
            </div>
            <div className="min-w-[12rem] flex-1">
              <label className={label}>Annual plan ID</label>
              <input
                className={input}
                value={gwAnnual}
                onChange={(e) => setGwAnnual(e.target.value)}
                placeholder="plan_…"
                spellCheck={false}
              />
            </div>
            <button
              type="button"
              disabled={pending || !gatewayDirty}
              onClick={() =>
                onSaveGateway({
                  gatewayMonthlyPlanId: gwMonthly,
                  gatewayAnnualPlanId: gwAnnual,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
            >
              <Check size={15} /> Link
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {plan.gatewayMonthlyPlanId || plan.gatewayAnnualPlanId
              ? 'A business can subscribe on the periods mapped above. The price is checked against this catalogue before any subscription is created.'
              : 'Not connected — no business can subscribe to this plan yet. An operator can still assign it by hand.'}
          </p>
        </div>
        </>
        )}
      </div>
    </section>
  )
}
