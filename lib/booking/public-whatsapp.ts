import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { normalizeWhatsappGroupUrl } from '@/lib/settings/whatsapp-group'

/**
 * The venue's WhatsApp group invite, for the public confirmation page.
 *
 * Reads through public_whatsapp_group() (migration 0103), a SECURITY DEFINER
 * projection returning one scalar — the same device getPublicTenantBySlug()
 * uses, and for the same reason: business_profiles holds the GSTIN, legal name
 * and registered address, none of which may cross onto a public page just to
 * hand out a group link.
 *
 * Tenant isolation is the function's, not this file's: it pins
 * current_public_tenant_id() — the GUC withPublicTenant() sets from the
 * subdomain — on top of the id it is given, so another venue's tenant id
 * returns null rather than that venue's invite.
 *
 * ── Why the URL is validated AGAIN here ─────────────────────────────────────
 *
 * It was validated by the settings schema on the way in and is pinned to
 * chat.whatsapp.com by a CHECK constraint. This third pass exists because the
 * value's next stop is `window.location.href` on a page every booking customer
 * lands on: a row written before 0103's CHECK existed, by a future migration,
 * or by a direct SQL edit, must not be able to redirect anybody off-host.
 * Re-normalising also means the browser only ever receives the canonical form,
 * with no query string for anything to be appended to.
 *
 * Null means "no invite to offer" for every reason at once — not configured,
 * switched off, or stored invalid — because the page treats all three
 * identically: it renders no countdown and no button, and the booking is
 * entirely unaffected.
 */
export const getPublicWhatsappGroupUrl = cache(async function getPublicWhatsappGroupUrl(
  tenantId: string,
): Promise<string | null> {
  const { rows } = await withPublicTenant(tenantId, (tx) =>
    tx.execute<{ url: string | null }>(
      sql`select public.public_whatsapp_group(${tenantId}::uuid) as url`,
    ),
  )
  return normalizeWhatsappGroupUrl(rows[0]?.url ?? null)
})
