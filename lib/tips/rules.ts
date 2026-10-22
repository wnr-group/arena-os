/**
 * Tip distribution (M20 / AROS-181) — a PURE function: tips + who worked how
 * long + the tenant's rules in, a per-person payout out. No DB, no
 * `server-only`, so the screens, the service and the unit tests share one
 * definition (the same shape as lib/billing/pricing).
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *   direct  a server keeps the tips left on THEIR tables (minus the tip-out %).
 *   pooled  every tip is summed and split by hours worked.
 *   tip-out `tipOutPct` % of the tips (of each server's own, when direct; of
 *           the whole pool, when pooled) is set aside for `tipOutRoles`
 *           (kitchen, bar…), split among them by hours worked.
 *   unattributed tips (no server on the table and no named recipient) join the
 *           shared pot split by hours among `poolRoles` — in either mode — so
 *           the money never silently disappears.
 *
 * ── EXACTNESS ───────────────────────────────────────────────────────────────
 * Everything is computed in whole PAISE and shares are apportioned with the
 * largest-remainder method, so  Σ payouts + undistributed === total tips,
 * to the paisa, every time. If nobody eligible worked (an empty pool, or no
 * tip-out recipient clocked in), that part is NOT invented: a tip-out with no
 * recipient is simply not taken (the servers keep it), and a pool with nobody
 * in it is reported as `undistributed` for the owner to deal with.
 */

export type TipMode = 'direct' | 'pooled'

export type TipRules = {
  mode: TipMode
  /** 0–100 */
  tipOutPct: number
  poolRoles: string[]
  tipOutRoles: string[]
}

export const DEFAULT_TIP_RULES: TipRules = { mode: 'direct', tipOutPct: 0, poolRoles: ['floor_staff'], tipOutRoles: [] }

/** Roles a person can hold (memberships.role) — the only values a rule may name. */
export const TIP_ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff', 'kitchen_staff'] as const

export type TipEntry = {
  /** Who the tip belongs to when direct; null = unattributed. */
  recipientId: string | null
  amount: number
}

export type TipPerson = { membershipId: string; role: string; hours: number }

export type PersonPayout = {
  membershipId: string
  /** Tips from their own tables they kept (direct mode). */
  own: number
  /** Their hours-weighted share of the shared pot. */
  poolShare: number
  /** Their hours-weighted share of the tip-out. */
  tipOutReceived: number
  /** What they gave up to the tip-out (direct mode; informational). */
  tippedOut: number
  hours: number
  total: number
}

export type TipResult = {
  payouts: PersonPayout[]
  totalTips: number
  distributed: number
  /** Tips nobody eligible could be paid (empty pool). */
  undistributed: number
  /** Of the total, tips with no server/recipient. */
  unattributed: number
  /** True when a tip-out % was set but nobody in tipOutRoles worked, so it was not taken. */
  tipOutSkipped: boolean
}

const toPaise = (n: number): number => Math.round(n * 100)
const fromPaise = (p: number): number => p / 100

/**
 * Split `totalPaise` across weights, whole paise only, largest remainder first
 * (ties broken by input order so the result is deterministic).
 */
export function apportion(totalPaise: number, weights: { id: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  const live = weights.filter((w) => w.weight > 0 && Number.isFinite(w.weight))
  const sum = live.reduce((n, w) => n + w.weight, 0)
  if (totalPaise <= 0 || sum <= 0) return out
  const exact = live.map((w, i) => {
    const share = (totalPaise * w.weight) / sum
    return { id: w.id, i, floor: Math.floor(share), frac: share - Math.floor(share) }
  })
  let left = totalPaise - exact.reduce((n, e) => n + e.floor, 0)
  const order = [...exact].sort((a, b) => b.frac - a.frac || a.i - b.i)
  const extra = new Map<string, number>()
  for (let k = 0; left > 0 && k < order.length; k++, left--) extra.set(order[k].id, 1)
  for (const e of exact) out.set(e.id, e.floor + (extra.get(e.id) ?? 0))
  return out
}

export function validateTipRules(r: TipRules): string | null {
  if (r.mode !== 'direct' && r.mode !== 'pooled') return 'Choose direct or pooled.'
  if (!Number.isFinite(r.tipOutPct) || r.tipOutPct < 0 || r.tipOutPct > 100) return 'Tip-out must be between 0% and 100%.'
  const known = new Set<string>(TIP_ROLES)
  for (const role of [...r.poolRoles, ...r.tipOutRoles]) if (!known.has(role)) return `Unknown role “${role}”.`
  if (r.poolRoles.some((x) => r.tipOutRoles.includes(x))) return 'A role can’t be both in the tip pool and receive the tip-out.'
  if (r.mode === 'pooled' && r.poolRoles.length === 0) return 'Choose at least one role that shares the pool.'
  if (r.tipOutPct > 0 && r.tipOutRoles.length === 0) return 'Choose who receives the tip-out, or set it to 0%.'
  return null
}

export function computeTipDistribution(input: { rules: TipRules; tips: TipEntry[]; people: TipPerson[] }): TipResult {
  const { rules, people } = input
  const problem = validateTipRules(rules)
  if (problem) throw new Error(problem)
  for (const t of input.tips) {
    if (!Number.isFinite(t.amount) || t.amount < 0) throw new Error('Tip amounts must be zero or more.')
  }

  // Tips in whole paise, per recipient (null = unattributed).
  const byRecipient = new Map<string, number>()
  let unattributed = 0
  for (const t of input.tips) {
    const p = toPaise(t.amount)
    if (p === 0) continue
    if (t.recipientId === null) unattributed += p
    else byRecipient.set(t.recipientId, (byRecipient.get(t.recipientId) ?? 0) + p)
  }
  const total = [...byRecipient.values()].reduce((n, v) => n + v, 0) + unattributed

  const eligible = (roles: string[]) => people.filter((p) => roles.includes(p.role) && p.hours > 0)
  const tipOutPeople = eligible(rules.tipOutRoles)
  const poolPeople = eligible(rules.poolRoles)

  // A tip-out nobody can receive is not taken.
  const tipOutSkipped = rules.tipOutPct > 0 && tipOutPeople.length === 0
  const pct = tipOutSkipped ? 0 : rules.tipOutPct
  const cut = (p: number) => Math.round((p * pct) / 100)

  const acc = new Map<string, PersonPayout>()
  const person = (id: string): PersonPayout => {
    let e = acc.get(id)
    if (!e) {
      const known = people.find((p) => p.membershipId === id)
      e = { membershipId: id, own: 0, poolShare: 0, tipOutReceived: 0, tippedOut: 0, hours: known?.hours ?? 0, total: 0 }
      acc.set(id, e)
    }
    return e
  }
  const ownP = new Map<string, number>()
  const poolP = new Map<string, number>()
  const outP = new Map<string, number>()
  const gaveP = new Map<string, number>()
  const add = (m: Map<string, number>, id: string, v: number) => m.set(id, (m.get(id) ?? 0) + v)

  let potOut = 0
  let sharePot = 0
  if (rules.mode === 'direct') {
    for (const [id, tp] of byRecipient) {
      const out = cut(tp)
      potOut += out
      add(ownP, id, tp - out)
      if (out > 0) add(gaveP, id, out)
    }
    const outU = cut(unattributed)
    potOut += outU
    sharePot = unattributed - outU
  } else {
    potOut = cut(total)
    sharePot = total - potOut
  }

  // Tip-out → its recipients, by hours.
  for (const [id, v] of apportion(potOut, tipOutPeople.map((p) => ({ id: p.membershipId, weight: p.hours })))) add(outP, id, v)
  // Shared pot → pool members, by hours.
  const poolShares = apportion(sharePot, poolPeople.map((p) => ({ id: p.membershipId, weight: p.hours })))
  for (const [id, v] of poolShares) add(poolP, id, v)

  const poolPaid = [...poolShares.values()].reduce((n, v) => n + v, 0)
  const undistributed = sharePot - poolPaid

  for (const [id, v] of ownP) person(id).own = fromPaise(v)
  for (const [id, v] of poolP) person(id).poolShare = fromPaise(v)
  for (const [id, v] of outP) person(id).tipOutReceived = fromPaise(v)
  for (const [id, v] of gaveP) person(id).tippedOut = fromPaise(v)

  const payouts = [...acc.values()]
    .map((p) => ({ ...p, total: fromPaise(toPaise(p.own) + toPaise(p.poolShare) + toPaise(p.tipOutReceived)) }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total || a.membershipId.localeCompare(b.membershipId))

  const distributed = payouts.reduce((n, p) => n + toPaise(p.total), 0)
  return {
    payouts,
    totalTips: fromPaise(total),
    distributed: fromPaise(distributed),
    undistributed: fromPaise(undistributed),
    unattributed: fromPaise(unattributed),
    tipOutSkipped,
  }
}

/** Calendar month 'YYYY-MM' → inclusive [start, end] dates. */
export function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, '0')}` }
}

export const isTipPeriod = (p: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(p)

/** A month can only be closed once it is over (in the venue's calendar). */
export function isPeriodOver(period: string, todayLocal: string): boolean {
  return period < todayLocal.slice(0, 7)
}
