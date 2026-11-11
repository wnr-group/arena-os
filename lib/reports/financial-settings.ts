import 'server-only'
import { eq } from 'drizzle-orm'
import { withUser, type DB } from '@/db'
import { financialSettings } from '@/db/schema'
import { writeAudit } from '@/lib/billing/invoice'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * The tenant's opening-balance REFERENCE (M40 / AROS-358).
 *
 * A snapshot, not a flow: it is shown beside the P&L for context and is never
 * added into Net Profit. `amount` is a numeric(12,2) STRING end to end.
 */
export type OpeningBalance = {
  /** numeric(12,2) as a string, e.g. '-1500.00'. */
  amount: string
  /** `YYYY-MM-DD`, or null when only an amount was recorded. */
  asOf: string | null
}

export type FinancialSettings = { openingBalance: OpeningBalance | null }

export class OpeningBalanceError extends Error {}

/** Read inside an existing RLS-scoped transaction. Null amount = not set. */
export async function readFinancialSettings(tx: DB, tenantId: string): Promise<FinancialSettings> {
  const [row] = await tx
    .select({ amount: financialSettings.openingBalance, asOf: financialSettings.openingBalanceAsOf })
    .from(financialSettings)
    .where(eq(financialSettings.tenantId, tenantId))
    .limit(1)
  if (!row || row.amount === null) return { openingBalance: null }
  return { openingBalance: { amount: row.amount, asOf: row.asOf } }
}

export function getFinancialSettings(ctx: ActiveContext): Promise<FinancialSettings> {
  return withUser(ctx.user.id, (tx) => readFinancialSettings(tx, ctx.tenant.id))
}

const AMOUNT_RE = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Normalise to numeric(12,2) text by string handling only — no float. */
function normaliseAmount(raw: string): string {
  const m = AMOUNT_RE.exec(raw.trim())
  if (!m) throw new OpeningBalanceError('Enter a valid opening balance.')
  const [, sign, whole, frac = ''] = m
  const out = `${whole.replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0')}`
  return out === '0.00' ? out : `${sign}${out}`
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Upsert the opening balance and audit old → new. `null` clears it. The caller
 * has already passed requireManager() and the module.expenses gate; RLS
 * (financial_settings_manager_*) is the second, independent gate. A no-op save
 * writes and audits nothing. Returns the previous value.
 */
export async function setOpeningBalance(
  tx: DB,
  actor: { tenantId: string; membershipId: string },
  next: { amount: string; asOf: string | null } | null,
): Promise<OpeningBalance | null> {
  let value: OpeningBalance | null = null
  if (next) {
    if (typeof next.amount !== 'string') throw new OpeningBalanceError('Enter a valid opening balance.')
    if (next.asOf !== null && !validDate(next.asOf)) throw new OpeningBalanceError('Enter a valid date.')
    value = { amount: normaliseAmount(next.amount), asOf: next.asOf }
  }

  const old = (await readFinancialSettings(tx, actor.tenantId)).openingBalance
  if (old?.amount === value?.amount && (old?.asOf ?? null) === (value?.asOf ?? null)) return old

  const set = {
    openingBalance: value?.amount ?? null,
    openingBalanceAsOf: value?.asOf ?? null,
    updatedBy: actor.membershipId,
  }
  await tx
    .insert(financialSettings)
    .values({ tenantId: actor.tenantId, ...set })
    .onConflictDoUpdate({ target: financialSettings.tenantId, set })
  await writeAudit(tx, actor, {
    action: 'financial_settings.opening_balance_changed',
    entityType: 'financial_settings',
    entityId: actor.tenantId,
    before: { openingBalance: old?.amount ?? null, openingBalanceAsOf: old?.asOf ?? null },
    after: { openingBalance: value?.amount ?? null, openingBalanceAsOf: value?.asOf ?? null },
  })
  return old
}
