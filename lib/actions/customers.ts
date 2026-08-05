'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canViewCustomers } from '@/lib/auth/roles'
import {
  findOrCreateCustomer,
  findCustomerByRawPhone,
  CustomerError,
} from '@/lib/customers/service'

type Result = { error?: string }

type CreateResult = Result & {
  customerId?: string
  created?: boolean
  name?: string | null
}

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof CustomerError) return { error: e.message }
  if (e instanceof z.ZodError) {
    return { error: e.issues[0]?.message ?? 'Check the details and try again.' }
  }
  const msg = e instanceof Error ? e.message : 'Something went wrong.'
  // 23514 = check_violation on the E.164 constraint; 23505 = unique violation.
  // Both mean a phone problem, so say so in the user's terms.
  if (/check constraint|23514/i.test(msg)) return { error: 'Enter a valid phone number.' }
  if (/unique|duplicate|23505/i.test(msg)) return { error: 'That phone number is already on file.' }
  return { error: msg }
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
    const ctx = await requireContext()
    if (!canViewCustomers(ctx.role)) {
      throw new AuthError('You do not have access to customers.')
    }
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
