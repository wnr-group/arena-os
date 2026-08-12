/**
 * Promo codes — validating one, and consuming a use.
 *
 * Two deliberately separate steps:
 *
 *   validatePromo()      reads and computes. Pure of side effects, so a bill
 *                        that is previewed, abandoned or rejected downstream
 *                        never burns a use.
 *   consumePromoUse()    the single atomic write, called only once the bill is
 *                        actually going to exist.
 *
 * Both take a `tx` (like ./invoice.ts and ./payments.ts), so they run inside
 * the caller's RLS-scoped transaction and roll back with it.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { promoCodes } from '@/db/schema'
import { round2 } from './pricing'

type Db = NodePgDatabase<typeof schema>

/**
 * Normalise a code for lookup and storage comparison.
 *
 * The unique index is on `upper(code)`, so matching must upper-case too, and
 * surrounding whitespace from a paste or a barcode scanner must not turn a
 * valid code into "not found". Returns null for nothing usable.
 */
export function normalizePromoCode(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toUpperCase()
  return trimmed ? trimmed : null
}

export type PromoValidation =
  | { ok: true; discount: number; promoId: string; code: string }
  | { ok: false; reason: string }

/**
 * Resolve a code and work out what it takes off `subtotal`.
 *
 * Tenant-scoped by the query itself as well as by RLS. Returns a reason the
 * cashier can read; never a database error.
 *
 * Does NOT record a use — see consumePromoUse().
 */
export async function validatePromo(
  tx: Db,
  tenantId: string,
  code: string,
  subtotal: number,
): Promise<PromoValidation> {
  const normalized = normalizePromoCode(code)
  if (!normalized) return { ok: false, reason: 'Enter a promo code.' }

  // Validity is judged by the DATABASE clock (now()), never the browser's and
  // never the app server's, so a skewed machine cannot open or extend a window.
  const [promo] = await tx
    .select({
      id: promoCodes.id,
      code: promoCodes.code,
      discountType: promoCodes.discountType,
      discountValue: promoCodes.discountValue,
      maxUses: promoCodes.maxUses,
      uses: promoCodes.uses,
      isActive: promoCodes.isActive,
      notStarted: sql<boolean>`now() < ${promoCodes.validFrom}`,
      expired: sql<boolean>`now() > ${promoCodes.validUntil}`,
    })
    .from(promoCodes)
    .where(
      and(
        eq(promoCodes.tenantId, tenantId),
        sql`upper(${promoCodes.code}) = ${normalized}`,
      ),
    )
    .limit(1)

  if (!promo) return { ok: false, reason: 'Promo code not found.' }
  if (!promo.isActive) return { ok: false, reason: 'Promo code is inactive.' }
  if (promo.notStarted) return { ok: false, reason: 'Promo code is not active yet.' }
  if (promo.expired) return { ok: false, reason: 'Promo code has expired.' }
  // max_uses null = unlimited.
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) {
    return { ok: false, reason: 'Promo code usage limit reached.' }
  }

  const base = round2(Math.max(0, subtotal))
  const value = round2(Number(promo.discountValue))
  const raw = promo.discountType === 'percentage' ? (base * value) / 100 : value

  // Capped at the subtotal so a promo can never drive the taxable value below
  // zero — priceBill caps again, but the figure reported to the cashier here
  // has to be the truthful one.
  const discount = Math.min(round2(raw), base)

  return { ok: true, discount, promoId: promo.id, code: promo.code }
}

/**
 * Record one use, atomically. True if this caller got it.
 *
 * Delegates to public.consume_promo_use() (migration 0011), which is ONE
 * conditional UPDATE:
 *
 *   set uses = uses + 1
 *   where … and (max_uses is null or uses < max_uses)
 *
 * The row lock plus the re-checked predicate is what makes the last use of a
 * limited promo go to exactly one of two racing cashiers — a read-then-write
 * would hand it to both. It returns no row when the promo was exhausted or
 * expired in the meantime, which the caller must treat as a failure.
 *
 * It is SECURITY DEFINER because billing is "cashier and up" while the
 * promo_write policy is manager-only; the function can only ever add 1 to
 * `uses`, and it filters on the caller's own tenants, so it cannot be used to
 * touch anything else or reach another tenant.
 */
export async function consumePromoUse(
  tx: Db,
  tenantId: string,
  promoId: string,
): Promise<boolean> {
  const result = await tx.execute<{ consume_promo_use: number | null }>(
    sql`select public.consume_promo_use(${tenantId}::uuid, ${promoId}::uuid)`,
  )
  return result.rows[0]?.consume_promo_use != null
}
