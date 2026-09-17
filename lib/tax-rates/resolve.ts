import 'server-only'
import { and, eq, or } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { taxRates } from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * The tenant's implicit default tax rate for a scope ('food' or 'resources')
 * — what an item/resource type with no tax_rate_id of its own falls back to.
 *
 * Only auto-applies when there is EXACTLY ONE active rate eligible for the
 * scope (appliesTo is the scope itself or 'both'). Zero eligible rates means
 * nothing to default to; more than one is ambiguous — which of two "food"
 * rates should an unassigned item use? — so both cases return null and the
 * caller falls back to 0, same as before this existed. An owner with more
 * than one rate per scope still assigns explicitly, per item/type, via the
 * existing tax_rate_id picker.
 */
export async function resolveScopeDefaultTaxPercent(
  tx: Db,
  tenantId: string,
  scope: 'food' | 'resources',
): Promise<string | null> {
  const rows = await tx
    .select({ percent: taxRates.percent })
    .from(taxRates)
    .where(
      and(
        eq(taxRates.tenantId, tenantId),
        eq(taxRates.isActive, true),
        or(eq(taxRates.appliesTo, scope), eq(taxRates.appliesTo, 'both')),
      ),
    )
  return rows.length === 1 ? rows[0].percent : null
}

type TaxRateLike = { name: string; percent: string; appliesTo: 'food' | 'resources' | 'both'; isActive: boolean }

/**
 * Same matching rule as resolveScopeDefaultTaxPercent, over an
 * already-fetched list — for DISPLAY only (so a settings page can show "auto:
 * GST 5 (5%)" next to an item that has no tax_rate_id of its own, instead of
 * a blank "—" that looks like nothing is being charged when something is).
 */
export function findScopeDefaultTaxRate<T extends TaxRateLike>(taxRates: T[], scope: 'food' | 'resources'): T | null {
  const eligible = taxRates.filter((t) => t.isActive && (t.appliesTo === scope || t.appliesTo === 'both'))
  return eligible.length === 1 ? eligible[0] : null
}
