'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { expenses } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { uploadReceipt, deleteObject } from '@/lib/storage/s3'

type Result = { error?: string }

/**
 * Expense create / edit / delete (AROS-108).
 *
 * Manager-only at BOTH layers, deliberately: requireManager() here, and the
 * expenses_write RLS policy (auth_is_manager) in the database. A cashier
 * calling this server action directly — bypassing the hidden page and the
 * hidden buttons — is refused twice, so the UI guard is convenience, never the
 * security boundary.
 *
 * `tenantId` is never a parameter. It comes from the authenticated session and
 * then from RLS, so the browser cannot name the tenant it writes into. Every
 * mutation additionally carries an explicit `tenant_id` predicate, which is why
 * a manager of tenant A updating tenant B's expense id matches zero rows
 * instead of erroring — and changes nothing.
 */

/**
 * Postgres error code, dug out of however many wrappers sit on top of it.
 * Drizzle re-throws driver errors wrapped in its own Error whose `message` is
 * just `Failed query: …`, so matching on message text silently never fires.
 * Same helper as lib/actions/membership-plans.ts.
 */
function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const o = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof o.code === 'string') {
      return { code: o.code, constraint: typeof o.constraint === 'string' ? o.constraint : undefined }
    }
    cur = o.cause
  }
  return {}
}

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  // The plan does not include Expenses — a refusal about what the business
  // bought, not about who is asking.
  if (e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  const { code, constraint } = pgError(e)
  // 23503 = foreign_key_violation. The composite (tenant_id, category_id) /
  // (tenant_id, vendor_id) FKs fire here when an id does not exist OR belongs
  // to another tenant — the two are indistinguishable to the caller on
  // purpose, so this never confirms that some other tenant's id is real.
  if (code === '23503') {
    if (constraint?.includes('category')) return { error: 'Pick a category from the list.' }
    if (constraint?.includes('vendor')) return { error: 'Pick a vendor from the list.' }
    return { error: 'Pick a category and vendor from the lists.' }
  }
  // 23514 = check_violation — the DB backstops the amount rule Zod checks.
  if (code === '23514') return { error: 'Check the amount entered.' }

  console.error('[expenses] action failed:', e)
  return { error: 'Could not save the expense. Please try again.' }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The entry contract.
 *
 * `tenantId`, `createdAt` are deliberately absent — see the note above.
 *
 * `receiptUrl` (AROS-110) is the URL uploadExpenseReceipt() already returned,
 * NOT a URL the browser invented: it is only ever used as a value to store,
 * and the only URL this module ever DELETES is the one already in the row.
 * Passing null clears the receipt and cleans up the stored object.
 */
const expenseInput = z.object({
  amount: z.coerce
    .number({ invalid_type_error: 'Enter an amount.' })
    .finite('Enter a valid amount.')
    .nonnegative('An amount cannot be negative.')
    .max(99_999_999.99, 'That amount is too large.'),
  categoryId: z.string().uuid('Pick a category.'),
  // Optional: rent and salaries are real expenses with no supplier to name.
  // '' from an unselected <select> normalises to null rather than failing.
  vendorId: z
    .union([z.string().uuid('Pick a vendor from the list.'), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  spentOn: z
    .string()
    .regex(DATE_RE, 'Enter a valid date.')
    // Rejects '2026-02-30' and '2026-13-01', which the regex alone allows.
    .refine((s) => {
      const [y, m, d] = s.split('-').map(Number)
      const dt = new Date(Date.UTC(y, m - 1, d))
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    }, 'Enter a valid date.'),
  note: z
    .string()
    .trim()
    .max(500, 'Keep the note to 500 characters.')
    .optional()
    .transform((v) => (v ? v : null)),
  receiptUrl: z
    .union([z.string().url('That receipt link is not valid.'), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
})

const expenseId = z.string().uuid('That expense reference is not valid.')

/**
 * Money is written as a fixed 2-decimal STRING: the column is numeric(10,2) and
 * Drizzle reads it back as a string, so keeping the write side the same shape
 * means the value never makes a round trip through a JavaScript float.
 */
function toValues(v: z.output<typeof expenseInput>) {
  return {
    amount: v.amount.toFixed(2),
    categoryId: v.categoryId,
    vendorId: v.vendorId,
    spentOn: v.spentOn,
    note: v.note,
    receiptUrl: v.receiptUrl,
  }
}

/**
 * Upload a receipt and return its URL (AROS-110).
 *
 * Separate from create/update, mirroring uploadMenuItemImage(): the file goes
 * up when it is chosen, and the URL it yields is submitted with the rest of the
 * form. Manager-only, and the key prefix is built from the SESSION's tenant, so
 * a caller cannot write into another tenant's prefix.
 *
 * The upload never touches the database, so a failure here leaves any existing
 * receipt on the expense exactly as it was — the caller simply gets an error and
 * the row is not saved.
 */
export async function uploadExpenseReceipt(
  formData: FormData,
): Promise<{ url?: string; error?: string }> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    const file = formData.get('file')
    if (!(file instanceof File)) return { error: 'No file provided.' }
    // Type, size and emptiness are all validated server-side inside
    // uploadReceipt() — the browser's claims about them are not trusted.
    const url = await uploadReceipt(file, `tenants/${ctx.tenant.id}/expense-receipts`)
    return { url }
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message }
    // uploadReceipt throws user-safe validation messages; anything else is ours.
    if (e instanceof Error && /allowed|empty|smaller than/i.test(e.message)) return { error: e.message }
    console.error('[expenses] receipt upload failed:', e)
    return { error: 'Could not upload the receipt. Please try again.' }
  }
}

export async function createExpense(input: z.input<typeof expenseInput>): Promise<Result> {
  let v: z.output<typeof expenseInput> | undefined
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    v = expenseInput.parse(input)

    await withUser(ctx.user.id, (tx) =>
      tx.insert(expenses).values({ tenantId: ctx.tenant.id, ...toValues(v!) }),
    )

    revalidatePath('/expenses')
    return {}
  } catch (e) {
    // The row was never written, so the receipt uploaded moments ago is now an
    // orphan — bin it rather than leave it paid for and unreferenced.
    if (v?.receiptUrl) void deleteObject(v.receiptUrl)
    return fail(e)
  }
}

/**
 * Edit an expense.
 *
 * The update set is the FULL editable shape, so a field the manager left alone
 * is rewritten with its current value rather than nulled — and `tenant_id` is
 * never in it. The WHERE carries the tenant explicitly, so another tenant's id
 * matches nothing.
 */
export async function updateExpense(
  id: string,
  input: z.input<typeof expenseInput>,
): Promise<Result> {
  let v: z.output<typeof expenseInput> | undefined
  let previousReceipt: string | null = null
  let uploadedNew = false
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    const target = expenseId.parse(id)
    v = expenseInput.parse(input)

    const updated = await withUser(ctx.user.id, async (tx) => {
      // The OLD receipt is read from the row, never taken from the caller —
      // this is what stops a crafted request making the server delete an
      // arbitrary object. Tenant-scoped, so another tenant's id reads nothing.
      const [existing] = await tx
        .select({ receiptUrl: expenses.receiptUrl })
        .from(expenses)
        .where(and(eq(expenses.id, target), eq(expenses.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!existing) return false

      previousReceipt = existing.receiptUrl
      uploadedNew = !!v!.receiptUrl && v!.receiptUrl !== existing.receiptUrl

      await tx
        .update(expenses)
        .set(toValues(v!))
        .where(and(eq(expenses.id, target), eq(expenses.tenantId, ctx.tenant.id)))
      return true
    })

    // Not this tenant's expense (or already gone): nothing was written, and
    // crucially nothing was deleted either.
    if (!updated) return { error: 'That expense no longer exists.' }

    // The row now points at the new value, so the object it USED to point at is
    // safe to bin. Covers both replace (new url) and remove (null). Best-effort
    // by design — a failed cleanup must not fail a save that already committed.
    if (previousReceipt && previousReceipt !== v.receiptUrl) void deleteObject(previousReceipt)

    revalidatePath('/expenses')
    return {}
  } catch (e) {
    // The update did not commit. If a NEW file had just been uploaded for it,
    // that object is now orphaned — remove it, and leave the existing receipt
    // (still referenced by the unchanged row) alone.
    if (uploadedNew && v?.receiptUrl) void deleteObject(v.receiptUrl)
    return fail(e)
  }
}

/**
 * Delete an expense — a real delete, not a soft one.
 *
 * Unlike membership plans (which are retired because purchases point at them),
 * nothing references an expense row, so removing a mistyped entry should
 * actually remove it. Tenant-scoped in the WHERE and manager-gated by RLS, so a
 * manager of tenant A deleting tenant B's expense id affects zero rows.
 */
export async function deleteExpense(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    const target = expenseId.parse(id)

    const [row] = await withUser(ctx.user.id, async (tx) => {
      // Read the receipt off the row before it disappears, so the object can be
      // cleaned up too. Same pattern deleteMenuItem() uses for its image.
      const existing = await tx
        .select({ receiptUrl: expenses.receiptUrl })
        .from(expenses)
        .where(and(eq(expenses.id, target), eq(expenses.tenantId, ctx.tenant.id)))
        .limit(1)
      await tx.delete(expenses).where(and(eq(expenses.id, target), eq(expenses.tenantId, ctx.tenant.id)))
      return existing
    })

    if (row) void deleteObject(row.receiptUrl)

    revalidatePath('/expenses')
    return {}
  } catch (e) {
    return fail(e)
  }
}
