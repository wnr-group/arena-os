import 'server-only'
import { eq } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { paymentSettings } from '@/db/schema'
import type { OnlinePaymentPolicy } from '@/lib/booking/online-charge'

/**
 * The venue's booking-payment policy, for the PUBLIC booking flow (M36 #2).
 *
 * payment_settings is manager-only under RLS and the storefront has no user
 * session, so — like loadRazorpayCredentialsForTenant — this reads on the owner
 * connection, scoped to ONE already-resolved tenant id and projecting only the
 * three policy columns (never the credential columns). A tenant with no row is
 * the legacy `optional_full`.
 */
export async function loadOnlinePaymentPolicy(tenantId: string): Promise<OnlinePaymentPolicy> {
  const [row] = await ownerDb
    .select({
      mode: paymentSettings.onlinePaymentMode,
      advanceType: paymentSettings.advanceType,
      advanceValue: paymentSettings.advanceValue,
    })
    .from(paymentSettings)
    .where(eq(paymentSettings.tenantId, tenantId))
    .limit(1)
  if (!row) return { mode: 'optional_full', advanceType: null, advanceValue: null }
  return { ...row, advanceValue: row.advanceValue == null ? null : Number(row.advanceValue) }
}
