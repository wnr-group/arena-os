import 'server-only'
import type { DB } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { getEntitlements, readEntitlements, type EntitlementValue } from './entitlements'

/**
 * Entitlement enforcement (M16 #2) — the one place that decides whether a
 * tenant's plan permits a module or another item.
 *
 * ── This is a THIRD layer, not a replacement ────────────────────────────────
 *
 * Every call site keeps the guards it already had. The order is always:
 *
 *     requireManager()        ← WHO you are        (lib/auth/guard.ts)
 *       → requireEntitlement()/checkLimit()  ← WHAT YOUR PLAN INCLUDES (here)
 *         → business logic + RLS              ← WHICH ROWS you may touch
 *
 * They answer different questions and neither substitutes for the other: an
 * owner on a Starter plan is fully authorised and still may not run payroll,
 * and a cashier on Enterprise is entitled and still may not.
 *
 * ── FAIL-CLOSED. Read this before changing anything below ───────────────────
 *
 * readEntitlements() (M16 #1) returns the SAME empty answer — `plan: null`,
 * `entitlements: {}` — for a tenant with no subscription, an expired one, a
 * cancelled one, one lapsed on the clock, and for a cross-tenant probe. That is
 * deliberate, and everything here is built on it:
 *
 *   * a module is granted ONLY by an explicit `true`. Missing, false, null,
 *     0, "yes" — all denied.
 *   * a limit is granted ONLY by an explicit non-negative number, or by an
 *     explicit `null` meaning UNLIMITED. A MISSING key is denied outright —
 *     absence must never read as "no ceiling", which is exactly the mistake
 *     that turns a billing model into a free-for-all.
 *
 * `null` (unlimited) and a missing key are therefore opposites, and only one of
 * them can be produced by an operator deliberately typing it into the admin UI.
 *
 * ── What "denied" costs, and what it does not ───────────────────────────────
 *
 * Denial blocks CREATING new limited items and ENTERING gated modules. It never
 * deletes anything, never touches existing rows, and never blocks reading,
 * editing or removing what a tenant already has — so a lapsed plan cannot strand
 * a business's data, and re-assigning a plan restores everything immediately.
 */

/** A plan-level refusal. Distinct from AuthError, which is about role. */
export class EntitlementError extends Error {
  /** The entitlement key that refused, for logging and for tests. */
  readonly key: string
  constructor(message: string, key: string) {
    super(message)
    this.name = 'EntitlementError'
    this.key = key
  }
}

const NO_PLAN_MODULE = (label: string) =>
  `This workspace has no active plan, so ${label} is unavailable. Ask your administrator to assign one.`

const NOT_IN_PLAN = (label: string) =>
  `${label} is not included in your plan. Upgrade your plan to enable it.`

/**
 * "module.payroll" → "Payroll"; "module.website_builder" → "Website builder".
 *
 * Derived rather than looked up in a table on purpose: a map would have to be
 * edited every time an operator invents a key, which is precisely the coupling
 * entitlements-as-data exists to avoid. An unknown key still produces a
 * readable sentence.
 */
function moduleLabel(key: string): string {
  const tail = key.startsWith('module.') ? key.slice('module.'.length) : key
  const words = tail.replace(/[_.]/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "max_branches" → { one: "branch", many: "branches" } is NOT derivable; see checkLimit. */
export type LimitLabel = { one: string; many: string }

function limitLabel(key: string, label?: LimitLabel): LimitLabel {
  if (label) return label
  // Generic fallback for a key no call site named: "max_widgets" → "widgets".
  const tail = key.startsWith('max_') ? key.slice('max_'.length) : key
  const many = tail.replace(/[_.]/g, ' ').trim()
  return { one: many, many }
}

/**
 * A tenant's effective entitlements, already resolved.
 *
 * EXPORTED (M16 #5) so a read-only surface — the owner billing portal — can ask
 * the same questions this module answers for enforcement, without opening a
 * second transaction and without restating the rules. The interpreters below
 * are the single definition of what a value MEANS; exporting them is what stops
 * a "3 of 5 used" bar and the guard that blocks the 6th from ever disagreeing.
 */
export type Resolved = { entitlements: Record<string, EntitlementValue>; hasPlan: boolean }

/** The two ways to obtain the tenant's effective entitlements. */
async function resolveFromCtx(ctx: ActiveContext): Promise<Resolved> {
  const e = await getEntitlements(ctx)
  return { entitlements: e.entitlements, hasPlan: e.plan !== null }
}

async function resolveFromTx(tx: DB, tenantId: string): Promise<Resolved> {
  const e = await readEntitlements(tx, tenantId)
  return { entitlements: e.entitlements, hasPlan: e.plan !== null }
}

// ── modules ──────────────────────────────────────────────────────────────────

/**
 * Granted ONLY by an explicit boolean true. Everything else is denied.
 *
 * Exported for presentation (see Resolved above). Enforcement still goes
 * through requireEntitlement()/requireEntitlementIn(), which throw.
 */
export function moduleGranted(r: Resolved, key: string): boolean {
  return r.entitlements[key] === true
}

function moduleRefusal(r: Resolved, key: string): EntitlementError {
  const label = moduleLabel(key)
  return new EntitlementError(r.hasPlan ? NOT_IN_PLAN(label) : NO_PLAN_MODULE(label), key)
}

/**
 * Throw unless the tenant's plan enables `key`.
 *
 * The primary module gate. Call it in the server action AND in the module's
 * data reader — the action is what stops a crafted POST, the reader is what
 * stops a page rendering data the plan does not cover. A hidden nav item is
 * neither, and is never the gate.
 */
export async function requireEntitlement(ctx: ActiveContext, key: string): Promise<void> {
  const r = await resolveFromCtx(ctx)
  if (!moduleGranted(r, key)) throw moduleRefusal(r, key)
}

/** Same rule, inside a transaction the caller has already opened. */
export async function requireEntitlementIn(tx: DB, tenantId: string, key: string): Promise<void> {
  const r = await resolveFromTx(tx, tenantId)
  if (!moduleGranted(r, key)) throw moduleRefusal(r, key)
}

/**
 * Non-throwing form, for PRESENTATION only — deciding whether to render a page
 * or redirect. Never the enforcement point: a page that checks this and forgets
 * to gate its reader is still protected, because the reader throws.
 */
export async function hasEntitlement(ctx: ActiveContext, key: string): Promise<boolean> {
  return moduleGranted(await resolveFromCtx(ctx), key)
}

// ── limits ───────────────────────────────────────────────────────────────────

export type LimitDecision =
  | { kind: 'unlimited' }
  | { kind: 'limit'; limit: number }
  | { kind: 'denied'; reason: 'no_plan' | 'missing' | 'malformed' }

/**
 * Interpret one limit key. The whole fail-closed rule lives here so there is a
 * single place to audit it.
 */
export function decideLimit(r: Resolved, key: string): LimitDecision {
  // Object.hasOwn, not `key in`: the entitlement map is a plain object literal,
  // so `in` also answers true for everything on Object.prototype. A plan that
  // never mentioned `toString` would report 'malformed' rather than 'missing'
  // and show the operator the wrong message. Both are denials — this is a
  // correctness fix to the REASON, not to the decision.
  if (!Object.hasOwn(r.entitlements, key)) {
    // Two different silences, deliberately distinguished for the MESSAGE only —
    // both are denials. "No plan" is an operator problem ("assign one"); a plan
    // that simply omits the key is a catalogue problem ("upgrade").
    return { kind: 'denied', reason: r.hasPlan ? 'missing' : 'no_plan' }
  }
  const v = r.entitlements[key]
  // An explicit null is the operator typing "unlimited" in the admin UI. It is
  // the ONLY way to get an uncapped answer out of this function.
  if (v === null) return { kind: 'unlimited' }
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0) {
    return { kind: 'limit', limit: v }
  }
  // A boolean or string where a number belongs: a misconfigured plan. Denied
  // rather than coerced — guessing what `"5 "` or `true` meant is how a limit
  // silently becomes infinity.
  return { kind: 'denied', reason: 'malformed' }
}

function limitRefusal(
  d: Extract<LimitDecision, { kind: 'denied' } | { kind: 'limit' }>,
  key: string,
  label: LimitLabel,
): EntitlementError {
  if (d.kind === 'limit') {
    const noun = d.limit === 1 ? label.one : label.many
    return new EntitlementError(
      `Your plan allows ${d.limit} ${noun}. Upgrade your plan to add more.`,
      key,
    )
  }
  if (d.reason === 'no_plan') {
    return new EntitlementError(
      `This workspace has no active plan, so no more ${label.many} can be added. Ask your administrator to assign one.`,
      key,
    )
  }
  if (d.reason === 'missing') {
    return new EntitlementError(
      `Your plan does not include ${label.many}. Upgrade your plan to add them.`,
      key,
    )
  }
  return new EntitlementError(
    `The ${label.many} limit on your plan is not configured correctly. Contact your administrator.`,
    key,
  )
}

/**
 * Throw unless ONE MORE item may be created.
 *
 * `currentCount` must be counted server-side, in the tenant's own RLS-scoped
 * context — see lib/platform/usage.ts. A count that arrives from the browser is
 * a number the caller chose, which would make the limit advisory.
 *
 * ── TAKE THE LOCK FIRST. This is not optional ───────────────────────────────
 *
 *     await lockTenantUsage(tx, tenantId)          // ← before the count
 *     await checkLimitIn(tx, tenantId, key, await countX(tx, tenantId), label)
 *     await tx.insert(...)
 *
 * Counting and then inserting is a check-then-act: concurrent requests all read
 * the same "one under the limit" and all write. This is not theoretical and it
 * is not small — scripts/test-m16-limit-race.ts measured EIGHT admitted against
 * a cap of THREE. lockTenantUsage() (lib/platform/usage.ts) serialises the
 * count, the check and the write per tenant, and closes it.
 *
 * The lock cannot be taken inside this function: it has to be held BEFORE the
 * count is read, and the count arrives here already taken. That is the one
 * thing a new call site has to get right, which is why it is stated here rather
 * than only in the module that provides the lock.
 *
 * The comparison is `currentCount >= limit`, i.e. it answers "would adding one
 * exceed the plan?", not "has the plan already been exceeded?". A tenant sitting
 * exactly ON its limit is legal (it is what a full plan looks like); a tenant
 * ABOVE it — after a downgrade — is also legal and simply cannot add more,
 * which is why nothing here deletes anything.
 */
export async function checkLimit(
  ctx: ActiveContext,
  key: string,
  currentCount: number,
  label?: LimitLabel,
): Promise<void> {
  assertLimit(await resolveFromCtx(ctx), key, currentCount, label)
}

/**
 * Same rule, inside a transaction the caller has already opened.
 *
 * This is the form every enforcement site uses, so it is the one that has to
 * carry the warning: call `lockTenantUsage(tx, tenantId)` BEFORE reading
 * `currentCount`, or the limit does not hold under concurrency. See checkLimit()
 * above for the measurement and the reason the lock cannot live in here.
 */
export async function checkLimitIn(
  tx: DB,
  tenantId: string,
  key: string,
  currentCount: number,
  label?: LimitLabel,
): Promise<void> {
  assertLimit(await resolveFromTx(tx, tenantId), key, currentCount, label)
}

function assertLimit(r: Resolved, key: string, currentCount: number, label?: LimitLabel): void {
  const d = decideLimit(r, key)
  if (d.kind === 'unlimited') return
  const l = limitLabel(key, label)
  if (d.kind === 'denied') throw limitRefusal(d, key, l)
  if (currentCount >= d.limit) throw limitRefusal(d, key, l)
}

/**
 * The limit as a number, for showing "3 of 5 used" in a UI. PRESENTATION only.
 * `null` means unlimited; `0` covers every denial, which is the fail-closed
 * reading a progress bar should show anyway.
 */
export async function limitFor(ctx: ActiveContext, key: string): Promise<number | null> {
  const d = decideLimit(await resolveFromCtx(ctx), key)
  if (d.kind === 'unlimited') return null
  return d.kind === 'limit' ? d.limit : 0
}
