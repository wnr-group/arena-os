/**
 * Find-or-create customer — the shared entry point to the customer directory.
 */
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { customers } from '@/db/schema'
import { normalizePhone } from './phone'
import { normalizeTags } from './tags'

type Db = NodePgDatabase<typeof schema>

export type Customer = typeof customers.$inferSelect

export type FindOrCreateCustomerInput = {
  phone: string
  name?: string | null
  email?: string | null
}

/** Thrown for caller-fixable input; actions map it to a field error. */
export class CustomerError extends Error {}

/** Trim to null so '' and '   ' never reach the database as empty strings. */
function blankToNull(v: string | null | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

/**
 * Return the tenant's customer for this phone number, creating one if it is the
 * first time we've seen it. Idempotent: repeated calls with any formatting of
 * the same number always return the same row and never create a second.
 */
export async function findOrCreateCustomer(
  tx: Db,
  tenantId: string,
  input: FindOrCreateCustomerInput,
): Promise<Customer> {
  const phone = normalizePhone(input.phone)
  if (!phone) {
    throw new CustomerError('Enter a valid phone number.')
  }

  const existing = await findCustomerByPhone(tx, tenantId, phone)
  if (existing) return existing

  // Not found — try to claim the number. `on conflict do nothing` makes this
  // safe against a concurrent caller creating the same customer between our
  // read and our write: at most one insert wins and the loser gets no row back.
  const [created] = await tx
    .insert(customers)
    .values({
      tenantId,
      phone,
      name: blankToNull(input.name),
      email: blankToNull(input.email),
    })
    .onConflictDoNothing({ target: [customers.tenantId, customers.phone] })
    .returning()

  if (created) return created

  // We lost the race. The winner has committed by now (the conflicting insert
  // blocked until it did), so re-reading finds their row — the caller still
  // gets the one customer that exists for this phone.
  const winner = await findCustomerByPhone(tx, tenantId, phone)
  if (!winner) {
    throw new CustomerError('Could not create the customer. Please try again.')
  }
  return winner
}

/** Look up a customer by an ALREADY-NORMALISED phone within one tenant. */
async function findCustomerByPhone(
  tx: Db,
  tenantId: string,
  normalizedPhone: string,
): Promise<Customer | null> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.phone, normalizedPhone)))
    .limit(1)
  return row ?? null
}

/**
 * Search the tenant's directory by phone, accepting any input format. Returns
 * null for both "not a phone number" and "no such customer" — callers treat
 * them the same way.
 */
export async function findCustomerByRawPhone(
  tx: Db,
  tenantId: string,
  rawPhone: string,
): Promise<Customer | null> {
  const phone = normalizePhone(rawPhone)
  if (!phone) return null
  return findCustomerByPhone(tx, tenantId, phone)
}

/**
 * Confirm a customer id belongs to this tenant, or throw.
 */
export async function assertCustomerInTenant(
  tx: Db,
  tenantId: string,
  customerId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
    .limit(1)

  if (!row) throw new CustomerError('That customer no longer exists.')
}

/**
 * Persist a customer's latest "order ready" notification preference (M14 #7,
 * v2) — called on every online order, since they may change their mind order
 * to order; there's no separate settings surface for this yet (M9's customer
 * portal is unbuilt).
 */
export async function setNotifyOrderReady(
  tx: Db,
  tenantId: string,
  customerId: string,
  value: boolean,
): Promise<void> {
  await tx
    .update(customers)
    .set({ notifyOrderReady: value })
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
}

export async function setCustomerTags(
  tx: Db,
  tenantId: string,
  customerId: string,
  tags: readonly (string | null | undefined)[],
): Promise<string[]> {
  const normalized = normalizeTags(tags)

  const [updated] = await tx
    .update(customers)
    .set({ tags: normalized })
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
    .returning({ tags: customers.tags })

  if (!updated) throw new CustomerError('That customer no longer exists.')
  return updated.tags
}
