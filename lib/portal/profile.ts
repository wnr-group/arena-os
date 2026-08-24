import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { withCustomer, type DB } from '@/db'
import { customers } from '@/db/schema'
import { requireCustomer } from '@/lib/auth/customer-guard'

/**
 * The customer's own profile and communication preferences.
 *
 * Same reader rule as the rest of lib/portal: identity comes from the SESSION
 * via requireCustomer(), the transaction is opened with withCustomer(), and RLS
 * scopes the row. No customer id is ever accepted from the browser.
 */

/** Exactly what the portal renders — not the whole row. */
export type PortalProfile = {
  name: string
  email: string
  /** Login identity. Displayed, never editable — see updateOwnProfile(). */
  phone: string
  smsOptIn: boolean
  emailOptIn: boolean
}

/**
 * Deliberately narrow. `tags` and `membershipStatus` are staff CRM annotations
 * — a customer should not see how the venue has labelled them — and `dob`,
 * `tenantId` and the timestamps are not part of this screen. Selecting only
 * these five columns means none of the rest can leak into a payload by
 * accident later.
 */
const PROFILE_COLUMNS = {
  name: customers.name,
  email: customers.email,
  phone: customers.phone,
  smsOptIn: customers.smsOptIn,
  emailOptIn: customers.emailOptIn,
}

export async function getCurrentCustomerProfile(): Promise<PortalProfile> {
  const customer = await requireCustomer()
  return withCustomer(customer.id, (tx) => readOwnProfile(tx, customer.id))
}

/**
 * The read, over an ALREADY customer-scoped transaction — the same split the
 * other portal readers use so it can be exercised from a plain Node script.
 *
 * The `id` predicate is belt-and-braces: RLS has already reduced `customers` to
 * exactly this customer's row, so an unqualified select would be correct. State
 * it anyway, so the query is right on its own terms rather than by reference to
 * a policy in another file.
 */
export async function readOwnProfile(tx: DB, customerId: string): Promise<PortalProfile> {
  const [row] = await tx
    .select(PROFILE_COLUMNS)
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  if (!row) {
    // RLS returning nothing for the session's own id means the customer row was
    // deleted mid-session. Blank rather than a crash; the guard will bounce
    // them on the next navigation anyway.
    throw new ProfileError('Your account could not be loaded. Please sign in again.')
  }

  return {
    name: row.name ?? '',
    email: row.email ?? '',
    phone: row.phone,
    smsOptIn: row.smsOptIn,
    emailOptIn: row.emailOptIn,
  }
}

export class ProfileError extends Error {}

/**
 * What the customer may change.
 *
 * `phone` is absent on purpose and is not merely omitted from the type — see
 * updateOwnProfile() and migration 0048 for why it is unreachable rather than
 * just unrequested.
 *
 * Both text fields accept empty, which clears them: the columns are nullable
 * (0014) and a customer who has never given an email must be able to leave it
 * blank, and to remove one later.
 */
export const profileSchema = z.object({
  name: z.string().trim().max(100, 'Keep it to 100 characters.').optional().default(''),
  email: z
    .string()
    .trim()
    .max(255, 'Keep it to 255 characters.')
    .email('Enter a valid email address.')
    .optional()
    .or(z.literal('')),
  smsOptIn: z.boolean(),
  emailOptIn: z.boolean(),
})

export type ProfileInput = z.input<typeof profileSchema>

/**
 * Save the customer's own profile.
 *
 * ── Why this goes through a database function ───────────────────────────────
 *
 * customer_update_profile() (migration 0048) is SECURITY DEFINER and names the
 * four editable columns in its own UPDATE, so `phone`, `tags` and
 * `membership_status` are unreachable BY CONSTRUCTION rather than by this file
 * remembering not to mention them.
 *
 * That matters more here than anywhere else in the portal. RLS is row-level, so
 * a customer UPDATE policy on `customers` could not have expressed "phone
 * unchanged" — WITH CHECK never sees the old row — and phone is the login
 * identity that OTP resolves an account by. `customers` therefore has no
 * customer UPDATE policy and no customer UPDATE grant at all.
 *
 * The function takes no customer id. It reads current_customer_id(), which the
 * surrounding withCustomer() set from a validated session, so this cannot be
 * pointed at another row even by a caller inside this process.
 */
export async function updateOwnProfile(tx: DB, input: ProfileInput): Promise<void> {
  const v = profileSchema.parse(input)

  const { rows } = await tx.execute<{ customer_update_profile: boolean }>(sql`
    select public.customer_update_profile(
      ${v.name || null},
      ${v.email || null},
      ${v.smsOptIn},
      ${v.emailOptIn}
    )
  `)

  if (rows[0]?.customer_update_profile !== true) {
    throw new ProfileError('Your profile could not be saved. Please sign in again and retry.')
  }
}
