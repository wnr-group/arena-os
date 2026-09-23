/**
 * The rule for attaching a booking to the customer directory.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { findOrCreateCustomer } from '@/lib/customers/service'
import { normalizePhone } from '@/lib/customers/phone'

type Db = NodePgDatabase<typeof schema>

/** Whatever contact details the guest gave at the desk. All optional. */
export type BookingContact = {
  phone?: string | null
  name?: string | null
  email?: string | null
}

export type ResolvedBookingCustomer = { id: string; name: string | null }

/**
 * Resolves the phone to a customer row and returns its directory name
 * alongside the id — a caller whose contact.name came back blank (e.g. the
 * public booking form skips asking for a name once it recognises the phone,
 * see lookupPublicCustomerByPhone) can fall back to this instead of writing
 * a nameless booking that then displays as "Walk-in".
 */
export async function resolveBookingCustomer(
  tx: Db,
  tenantId: string,
  contact: BookingContact,
): Promise<ResolvedBookingCustomer | null> {
  if (!contact.phone || !normalizePhone(contact.phone)) return null

  const customer = await findOrCreateCustomer(tx, tenantId, {
    phone: contact.phone,
    name: contact.name,
    email: contact.email,
  })
  return { id: customer.id, name: customer.name }
}
