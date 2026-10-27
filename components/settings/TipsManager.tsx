'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { finalizeTipPeriod, markTipPayoutPaid, reopenTipPeriod, saveTipRules } from '@/lib/actions/tips'
import { TIP_ROLES, type TipRules } from '@/lib/tips/rules'
import { formatMoney } from '@/lib/format'

const field = 'rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50'
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  receptionist: 'Receptionist',
  floor_staff: 'Floor staff / servers',
  kitchen_staff: 'Kitchen staff',
}

export type PayoutView = {
  /** id of the stored ledger row, when the month is finalised */
  id: string | null
  membershipId: string
  name: string
  amount: number
  status: 'pending' | 'paid'
  breakdown: Record<string, number>
}

export type PeriodView = {
  period: string
  finalized: boolean
  finalizedAt: string | null
  totalTips: number
  distributed: number
  undistributed: number
  unattributed: number
  tipOutSkipped: boolean
  canFinalize: boolean
  payouts: PayoutView[]
  /** Rules in force for this view (frozen ones when finalised). */
  rules: TipRules
}

function RolePicker({ value, onChange, exclude, label }: { value: string[]; onChange: (v: string[]) => void; exclude: string[]; label: string }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {TIP_ROLES.map((r) => {
          const blocked = exclude.includes(r)
          const on = value.includes(r)
          return (
            <label key={r} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm ${blocked ? 'opacity-40' : 'cursor-pointer'} ${on ? 'border-primary bg-primary/10' : 'border-border'}`}>
              <input type="checkbox" disabled={blocked} checked={on} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
              {ROLE_LABEL[r]}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function TipsManager({
  rules: initial,
  period,
  months,
  view,
  currency,
}: {
  rules: TipRules
  period: string
  months: string[]
  view: PeriodView
  currency: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [rules, setRules] = useState<TipRules>(initial)
  const money = (n: number) => formatMoney(n, currency)
  const dirty = JSON.stringify(rules) !== JSON.stringify(initial)

  function act(fn: () => Promise<{ error?: string }>, done?: string) {
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        if (done) toast.success(done)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-6 space-y-8">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold">How tips are shared</h2>
        <div className="mt-4 space-y-5">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            {(['direct', 'pooled'] as const).map((m) => (
              <label key={m} className={`cursor-pointer rounded-lg border p-3 ${rules.mode === m ? 'border-primary bg-primary/5' : 'border-border'}`}>
                <input type="radio" className="mr-2" name="tip-mode" checked={rules.mode === m} onChange={() => setRules({ ...rules, mode: m })} />
                <span className="font-medium">{m === 'direct' ? 'Direct' : 'Pooled'}</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {m === 'direct'
                    ? 'Each server keeps the tips left on their own tables.'
                    : 'All tips are added together and split by hours worked.'}
                </span>
              </label>
            ))}
          </fieldset>

          <label className="block text-sm">
            <span className="font-medium">Tip-out</span>
            <span className="mt-0.5 block text-muted-foreground">
              Share of {rules.mode === 'direct' ? 'each server’s tips' : 'the pool'} passed to the roles below (kitchen, bar…), split by hours worked.
            </span>
            <span className="mt-2 flex items-center gap-2">
              <input className={`${field} w-24`} type="number" min={0} max={100} step="any" value={rules.tipOutPct} onChange={(e) => setRules({ ...rules, tipOutPct: Number(e.target.value) })} />%
            </span>
          </label>

          <RolePicker
            label={rules.mode === 'pooled' ? 'Who shares the pool' : 'Who shares tips with no server (e.g. left on a takeaway)'}
            value={rules.poolRoles}
            exclude={rules.tipOutRoles}
            onChange={(v) => setRules({ ...rules, poolRoles: v })}
          />
          <RolePicker label="Who receives the tip-out" value={rules.tipOutRoles} exclude={rules.poolRoles} onChange={(v) => setRules({ ...rules, tipOutRoles: v })} />

          <button
            disabled={pending || !dirty}
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() => act(() => saveTipRules(rules), 'Tip rules saved.')}
          >
            Save rules
          </button>
          <p className="text-xs text-muted-foreground">Rules apply to months you finalise from now on. A month that is already finalised keeps the rules it was closed with.</p>
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Monthly payout</h2>
          <select className={field} value={period} onChange={(e) => router.push(`/settings/tips?period=${e.target.value}`)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Stat label="Tips collected" value={money(view.totalTips)} />
          <Stat label="Paid out" value={money(view.distributed)} />
          <Stat label="Unattributed" value={money(view.unattributed)} hint="No server / recipient" />
          <Stat label="Not distributed" value={money(view.undistributed)} tone={view.undistributed > 0 ? 'warn' : undefined} hint={view.undistributed > 0 ? 'Nobody eligible was clocked in' : undefined} />
        </div>

        {view.tipOutSkipped && !view.finalized && (
          <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700">Nobody in the tip-out roles clocked in this month, so no tip-out was taken — servers keep it.</p>
        )}

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2 text-right">Own tables</th>
                <th className="px-3 py-2 text-right">Pool share</th>
                <th className="px-3 py-2 text-right">Tip-out</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.payouts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No tips to distribute for {period}.
                  </td>
                </tr>
              )}
              {view.payouts.map((p) => (
                <tr key={p.membershipId} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{p.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.breakdown.hours ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.breakdown.own ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.breakdown.poolShare ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.breakdown.tipOutReceived ?? 0)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(p.amount)}</td>
                  <td className="px-3 py-2 text-right">
                    {view.finalized ? (
                      p.status === 'paid' ? (
                        <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600">Paid</span>
                      ) : (
                        <button disabled={pending || !p.id} className={`${btn} border border-border hover:bg-muted`} onClick={() => act(() => markTipPayoutPaid(p.id!), 'Marked paid.')}>
                          Mark paid
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {view.finalized ? (
            <>
              <span className="text-sm text-muted-foreground">Finalised {view.finalizedAt ? new Date(view.finalizedAt).toLocaleDateString('en-IN') : ''}. Payroll adds these to each payslip for {period}.</span>
              <button
                disabled={pending}
                className={`${btn} border border-border hover:bg-muted`}
                onClick={() => window.confirm(`Reopen ${period}? Only possible while nothing has been paid.`) && act(() => reopenTipPeriod(period), 'Reopened.')}
              >
                Reopen month
              </button>
            </>
          ) : (
            <>
              <button
                disabled={pending || !view.canFinalize || view.payouts.length === 0}
                className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
                onClick={() => window.confirm(`Finalise tips for ${period}? This freezes the amounts for payroll.`) && act(() => finalizeTipPeriod(period), 'Tips finalised.')}
              >
                Finalise {period}
              </button>
              <span className="text-sm text-muted-foreground">
                {view.canFinalize ? 'This is a preview from current payments and attendance.' : 'This month isn’t over yet — it can be finalised once it has ended.'}
              </span>
            </>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Hours come from clock-in / clock-out attendance; someone who never clocked out that day contributes no hours. Run payroll
          <em> after</em> finalising so the tips land on the payslip; if payroll has already run, use “Mark paid” for a manual settlement.
        </p>
      </section>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-600' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
