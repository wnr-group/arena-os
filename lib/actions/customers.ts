'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canViewCustomers } from '@/lib/auth/roles'
import type { ActiveContext } from '@/lib/tenant/context'
import {
  findOrCreateCustomer,
  findCustomerByRawPhone,
  assertCustomerInTenant,
  setCustomerTags,
  CustomerError,
} from '@/lib/customers/service'
import { createNote, updateNote, deleteNote } from '@/lib/customers/notes'
import { MAX_NOTE_LENGTH } from '@/lib/customers/note-body'
import { MAX_TAGS, MAX_TAG_LENGTH } from '@/lib/customers/tags'
import { zodErrorMessage } from '@/lib/utils/errors'

type Result = { error?: string }

type CreateResult = Result & {
  customerId?: string
  created?: boolean
  name?: string | null
}

type NoteResult = Result & { noteId?: string }

/** Carries the list AS STORED, so the client renders what the database holds. */
type TagsResult = Result & { tags?: string[] }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof CustomerError) return { error: e.message }
  if (e instanceof z.ZodError) {
    return { error: zodErrorMessage(e) }
  }
  const msg = e instanceof Error ? e.message : 'Something went wrong.'
  // 23514 = check_violation on the E.164 constraint; 23505 = unique violation.
  // Both mean a phone problem, so say so in the user's terms.
  if (/check constraint|23514/i.test(msg)) return { error: 'Enter a valid phone number.' }
  if (/unique|duplicate|23505/i.test(msg)) return { error: 'That phone number is already on file.' }
  return { error: msg }
}

/**
 * The one authorization gate for this module: an active membership in the tenant
 * (requireContext) whose role may work the customer directory. That is the
 * project's "staff and above" — every role in CUSTOMER_ROLES, i.e. everyone
 * except kitchen staff and non-members. Reads and writes share it, so nobody can
 * see a note they could not also have written.
 */
async function requireCustomerAccess(): Promise<ActiveContext> {
  const ctx = await requireContext()
  if (!canViewCustomers(ctx.role)) {
    throw new AuthError('You do not have access to customers.')
  }
  return ctx
}

/** Refresh the directory and the profile a customer's change is visible on. */
function revalidateCustomer(customerId: string) {
  revalidatePath('/customers')
  revalidatePath(`/customers/${customerId}`)
}

const createInput = z.object({
  phone: z.string().trim().min(1, 'Phone number is required'),
  name: z.string().trim().optional(),
  email: z.string().trim().email('Enter a valid email address').optional().or(z.literal('')),
})

/**
 * Quick-create a customer from the directory
 */
export async function createCustomer(input: z.input<typeof createInput>): Promise<CreateResult> {
  try {
    const ctx = await requireCustomerAccess()
    const v = createInput.parse(input)

    const result = await withUser(ctx.user.id, async (tx) => {
      // Look first so we can tell the user whether this was a new customer or a
      // match on an existing one. findOrCreateCustomer is idempotent either way.
      const existing = await findCustomerByRawPhone(tx, ctx.tenant.id, v.phone)
      const customer = await findOrCreateCustomer(tx, ctx.tenant.id, {
        phone: v.phone,
        name: v.name,
        email: v.email,
      })
      return { customer, created: !existing }
    })

    revalidatePath('/customers')
    return {
      customerId: result.customer.id,
      created: result.created,
      name: result.customer.name,
    }
  } catch (e) {
    return fail(e)
  }
}

// ── notes ────────────────────────────────────────────────────────────────────
const noteBody = z
  .string()
  .trim()
  .min(1, 'Write something before saving the note.')
  .max(MAX_NOTE_LENGTH, `Keep a note under ${MAX_NOTE_LENGTH} characters.`)

const createNoteInput = z.object({
  customerId: z.string().uuid('That customer no longer exists.'),
  body: noteBody,
})

const updateNoteInput = z.object({
  noteId: z.string().uuid('That note no longer exists.'),
  body: noteBody,
})

/** Add a note to a customer, attributed to the signed-in member. */
export async function createCustomerNote(
  input: z.input<typeof createNoteInput>,
): Promise<NoteResult> {
  try {
    const ctx = await requireCustomerAccess()
    const v = createNoteInput.parse(input)

    const note = await withUser(ctx.user.id, (tx) =>
      createNote(tx, ctx.tenant.id, {
        customerId: v.customerId,
        body: v.body,
        createdBy: ctx.membershipId,
      }),
    )

    revalidateCustomer(note.customerId)
    return { noteId: note.id }
  } catch (e) {
    return fail(e)
  }
}

/** Edit a note's text. The original author and time are left untouched. */
export async function updateCustomerNote(
  input: z.input<typeof updateNoteInput>,
): Promise<NoteResult> {
  try {
    const ctx = await requireCustomerAccess()
    const v = updateNoteInput.parse(input)

    const note = await withUser(ctx.user.id, (tx) =>
      updateNote(tx, ctx.tenant.id, v.noteId, v.body),
    )

    revalidateCustomer(note.customerId)
    return { noteId: note.id }
  } catch (e) {
    return fail(e)
  }
}

/** Delete one note. */
export async function deleteCustomerNote(noteId: string): Promise<NoteResult> {
  try {
    const ctx = await requireCustomerAccess()
    const id = z.string().uuid('That note no longer exists.').parse(noteId)

    const note = await withUser(ctx.user.id, (tx) => deleteNote(tx, ctx.tenant.id, id))

    revalidateCustomer(note.customerId)
    return { noteId: note.id }
  } catch (e) {
    return fail(e)
  }
}

// ── tags ─────────────────────────────────────────────────────────────────────
const tagsInput = z.object({
  customerId: z.string().uuid('That customer no longer exists.'),
  // Length is capped here only to bound the payload; normalizeTags() is what
  // decides the stored list — trimming, dropping blanks and de-duplicating.
  tags: z
    .array(z.string().max(MAX_TAG_LENGTH * 4))
    .max(MAX_TAGS * 4, `A customer can have at most ${MAX_TAGS} tags.`),
})

/**
 * Replace a customer's tags with the given list.
 *
 * One action covers add, remove and reorder-free editing: the client sends the
 * list it wants and gets back the list as stored, so a duplicate the UI missed
 * is still collapsed server-side rather than saved.
 */
export async function updateCustomerTags(
  input: z.input<typeof tagsInput>,
): Promise<TagsResult> {
  try {
    const ctx = await requireCustomerAccess()
    const v = tagsInput.parse(input)

    const tags = await withUser(ctx.user.id, async (tx) => {
      // Distinguishes "not this tenant's customer" from "wrote zero rows".
      await assertCustomerInTenant(tx, ctx.tenant.id, v.customerId)
      return setCustomerTags(tx, ctx.tenant.id, v.customerId, v.tags)
    })

    revalidateCustomer(v.customerId)
    return { tags }
  } catch (e) {
    return fail(e)
  }
}
