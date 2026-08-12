/**
 * Customer notes
 */
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { customerNotes } from '@/db/schema'
import { assertCustomerInTenant, CustomerError } from './service'
import { normalizeNoteBody } from './note-body'

type Db = NodePgDatabase<typeof schema>

export type CustomerNote = typeof customerNotes.$inferSelect

/**
 * Write a note against a customer.
 */
export async function createNote(
  tx: Db,
  tenantId: string,
  input: { customerId: string; body: string; createdBy: string | null },
): Promise<CustomerNote> {
  const body = normalizeNoteBody(input.body)
  if (!body) throw new CustomerError('Write something before saving the note.')

  // The composite FK from 0009 would refuse a customer from another tenant, but
  // check first so the caller gets "no such customer" instead of a raw FK error.
  await assertCustomerInTenant(tx, tenantId, input.customerId)

  const [created] = await tx
    .insert(customerNotes)
    .values({
      tenantId,
      customerId: input.customerId,
      body,
      createdBy: input.createdBy,
    })
    .returning()

  if (!created) throw new CustomerError('Could not save the note. Please try again.')
  return created
}

/**
 * Edit a note's text in place
 */
export async function updateNote(
  tx: Db,
  tenantId: string,
  noteId: string,
  body: string,
): Promise<CustomerNote> {
  const trimmed = normalizeNoteBody(body)
  if (!trimmed) throw new CustomerError('Write something before saving the note.')

  const [updated] = await tx
    .update(customerNotes)
    .set({ body: trimmed })
    .where(and(eq(customerNotes.tenantId, tenantId), eq(customerNotes.id, noteId)))
    .returning()

  if (!updated) throw new CustomerError('That note no longer exists.')
  return updated
}

/** Delete one note. Returns it, so the caller knows which profile to refresh. */
export async function deleteNote(
  tx: Db,
  tenantId: string,
  noteId: string,
): Promise<CustomerNote> {
  const [deleted] = await tx
    .delete(customerNotes)
    .where(and(eq(customerNotes.tenantId, tenantId), eq(customerNotes.id, noteId)))
    .returning()

  if (!deleted) throw new CustomerError('That note no longer exists.')
  return deleted
}
