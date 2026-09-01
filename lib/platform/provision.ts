import 'server-only'
import { eq } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { branches, expenseCategories, memberships, tenants, users } from '@/db/schema'
import { DEFAULT_EXPENSE_CATEGORIES } from '@/lib/expenses/defaults'
import { hashPassword } from '@/lib/auth/password'

/**
 * Find a global user by email, or create one. Runs on the OWNER connection —
 * user identity is platform infrastructure. Returns the user id and whether it
 * was newly created. When creating, a password is required.
 */
export async function findOrCreateUser(input: {
  email: string
  fullName?: string | null
  password?: string
}): Promise<{ userId: string; created: boolean }> {
  const email = input.email.trim().toLowerCase()

  const [existing] = await ownerDb.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing) return { userId: existing.id, created: false }

  if (!input.password) throw new Error('A password is required to create this user.')
  const passwordHash = await hashPassword(input.password)
  const [created] = await ownerDb
    .insert(users)
    .values({ email, passwordHash, fullName: input.fullName ?? null })
    .returning({ id: users.id })
  return { userId: created.id, created: true }
}

/**
 * THE tenant-provisioning transaction (M16 #6).
 *
 * ── Why this is a function and not two copies ───────────────────────────────
 *
 * This body used to live inline inside createCompany() in lib/actions/platform.ts,
 * where a platform admin was the only way a business came into existence.
 * Self-serve signup is a second entry point to the same thing, and the one
 * outcome that must never happen is the two diverging: a business that signed
 * up itself getting a different base setup from one an operator created, and
 * nobody noticing until a support call about a missing Main Branch.
 *
 * So there is exactly one copy, and both callers use it. createCompany() keeps
 * its own admin guard, its own availability check and its own revalidatePath —
 * that is UI and authorization, which differ per entry point — while everything
 * that touches the database lives here.
 *
 * ── What a brand-new tenant gets ────────────────────────────────────────────
 *
 *   tenants             the workspace itself
 *   branches            one 'Main Branch', primary
 *   memberships         the OWNER, active, attached to that branch
 *   expense_categories  the starter set, because an expense requires a category
 *                       and a fresh tenant would otherwise open the Expenses
 *                       page onto a form it cannot submit
 *
 * All four in ONE transaction. A tenant with no branch, or with no owner, is
 * not a degraded workspace — it is one nobody can sign in to and no booking can
 * be attached to, so a partial provision must not be reachable.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * No subscription. A plan is a separate concern with its own transaction, its
 * own gateway calls and its own failure modes (lib/platform/billing/subscribe.ts),
 * and folding it in here would mean a Razorpay outage could stop a workspace
 * from existing. The caller attaches a plan afterwards and decides what to do
 * if that part fails.
 *
 * No session. Provisioning does not sign anybody in; see lib/signup/service.ts
 * for why signup redirects to the tenant's own login page instead.
 */

/** Matches the tenant_industry enum in db/schema.ts (0001_init.sql, plus
 *  'restaurant' added by the food/kitchen work). */
export type TenantIndustry =
  | 'gaming_cafe'
  | 'recording_studio'
  | 'podcast_studio'
  | 'dance_studio'
  | 'vr_centre'
  | 'restaurant'
  | 'other'

export type ProvisionTenantInput = {
  companyName: string
  /** Already normalized and validated by the caller — see lib/platform/slug.ts. */
  slug: string
  industry: TenantIndustry
  currency: string
  timezone: string
  ownerEmail: string
  ownerName: string
  /** Only used when the user does not already exist. */
  ownerPassword: string
  /**
   * The ACCOUNT's state, which is not the subscription's.
   *
   * 'active' is the default because that is what createCompany() has always
   * written: an operator creating a business by hand has already decided it is
   * a real customer. Self-serve signup passes 'trial' instead — nobody has paid
   * anything yet, and the account moves to 'active' only when the webhook says
   * a charge succeeded (lib/platform/billing/lifecycle.ts).
   */
  status?: 'trial' | 'active'
}

export type ProvisionedTenant = {
  tenantId: string
  branchId: string
  membershipId: string
  userId: string
  /** False when the email already had an Arena OS account and was reused. */
  ownerCreated: boolean
  slug: string
}

export async function provisionTenant(
  input: ProvisionTenantInput,
  db: DB = ownerDb,
): Promise<ProvisionedTenant> {
  const ownerEmail = input.ownerEmail.trim().toLowerCase()

  // OUTSIDE the transaction, deliberately. hashPassword() is argon2id and takes
  // tens of milliseconds by design; holding a database transaction open across
  // it would pin a connection for no reason. It is also idempotent by email, so
  // a retry after a failed provision reuses the same user rather than failing.
  const { userId, created: ownerCreated } = await findOrCreateUser({
    email: ownerEmail,
    fullName: input.ownerName,
    password: input.ownerPassword,
  })

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: input.slug,
        name: input.companyName,
        industry: input.industry,
        status: input.status ?? 'active',
        currency: input.currency,
        timezone: input.timezone,
      })
      .returning({ id: tenants.id })

    const [branch] = await tx
      .insert(branches)
      .values({ tenantId: tenant.id, name: 'Main Branch', isPrimary: true })
      .returning({ id: branches.id })

    const [membership] = await tx
      .insert(memberships)
      .values({
        tenantId: tenant.id,
        userId,
        branchId: branch.id,
        // THE SERVER DECIDES THIS. There is no role parameter on this function
        // and there must never be one: the person provisioning a workspace is
        // its owner by definition, and a signup form that could name a role
        // would be a privilege-escalation field.
        role: 'owner',
        status: 'active',
        fullName: input.ownerName,
        email: ownerEmail,
      })
      .returning({ id: memberships.id })

    // Starter expense categories, the same way this transaction seeds a
    // 'Main Branch': an expense requires a category, so a brand-new tenant
    // would otherwise open the Expenses page onto a form it cannot submit.
    // Ordinary rows — renameable, retirable, and addable to.
    await tx.insert(expenseCategories).values(
      DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ tenantId: tenant.id, name })),
    )

    return {
      tenantId: tenant.id,
      branchId: branch.id,
      membershipId: membership.id,
      userId,
      ownerCreated,
      slug: input.slug,
    }
  })
}
