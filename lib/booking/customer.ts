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

export async function resolveBookingCustomer(
  tx: Db,
  tenantId: string,
  contact: BookingContact,
): Promise<string | null> {
  if (!contact.phone || !normalizePhone(contact.phone)) return null

  const customer = await findOrCreateCustomer(tx, tenantId, {
    phone: contact.phone,
    name: contact.name,
    email: contact.email,
  })
  return customer.id
}
