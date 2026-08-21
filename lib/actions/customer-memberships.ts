'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { withUser } from '@/db'
import type * as schema from '@/db/schema'
import { branches } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canBill } from '@/lib/auth/roles'
import {
  MembershipError,
  cancelMembership,
  purchaseMembership,
  purchaseMembershipInputSchema,
} from '@/lib/memberships/customer-memberships'

/**
 * Selling and cancelling customer memberships.
 *
 * Role rule follows recordPayment() and createDepositOrder(): **cashier and
 * up**. A membership purchase takes money, so the roles that may take money are
 * the roles that may sell one. Kitchen, floor and reception staff can see a
 * customer's membership — the till has to — but cannot sell or cancel.
 *
 * Nothing about tenant, price, duration or benefits comes from the client. The
 * action passes a customer id and a plan id to the core, which reads everything
 * else out of the database inside the same transaction.
 */

/** The tenant's primary branch, for the membership invoice's branch_id. */
async function primaryBranchId(
  tx: NodePgDatabase<typeof schema>,
  tenantId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true)))
    .limit(1)
  return row?.id ?? null
}

type Result = { error?: string; success?: true }
type PurchaseResult = Result & {
  membership?: {
    id: string
    planName: string
    pricePaid: number
    expiresAt: string
    walletCredited: number
    /** The GST invoice raised for the sale; null for a ₹0 comped membership. */
    invoiceNumber: string | null
  }
}

/** Postgres error code, dug out of Drizzle's wrapper. */
function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e
  for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
    const o = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof o.code === 'string') {
      return { code: o.code, constraint: typeof o.constraint === 'string' ? o.constraint : undefined }
    }
    cur = o.cause
  }
  return {}
}

function fail(e: unknown, op: string): Result {
  if (e instanceof AuthError || e instanceof MembershipError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  const { code, constraint } = pgError(e)
  // 23505 on the partial unique index: a concurrent till sold one first.
  if (code === '23505' && constraint === 'idx_customer_memberships_one_active') {
    return { error: 'This customer already holds an active membership.' }
  }
  if (code === '23514') return { error: 'Those membership values are not valid.' }

  console.error(`[customer-memberships] ${op} failed:`, e instanceof Error ? e.name : 'unknown')
  return { error: 'Could not complete the membership purchase. Please try again.' }
}

/**
 * Sell a plan to a customer.
 *
 * The benefits are snapshotted onto the new membership inside the transaction,
 * so a manager repricing the plan a second later cannot change what this
 * customer just bought. Any wallet credit the plan carries is granted through
 * the existing ledger in the same transaction.
 */
export async function purchaseCustomerMembership(
  input: z.input<typeof purchaseMembershipInputSchema>,
): Promise<PurchaseResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to sell memberships.')
    }
    const v = purchaseMembershipInputSchema.parse(input)

    const result = await withUser(ctx.user.id, async (tx) => {
      // invoices.branch_id is NOT NULL but a membership is not branch-scoped.
      // Use the seller's own branch, falling back to the tenant's primary —
      // resolved server-side, never sent by the client.
      const branchId = ctx.branchId ?? (await primaryBranchId(tx, ctx.tenant.id))
      if (!branchId) {
        throw new MembershipError('This venue has no branch configured.')
      }
      return purchaseMembership(
        tx,
        {
          tenantId: ctx.tenant.id,
          membershipId: ctx.membershipId,
          timezone: ctx.tenant.timezone,
          branchId,
        },
        v,
      )
    })

    revalidatePath(`/customers/${v.customerId}`)
    revalidatePath('/customers')

    return {
      success: true,
      membership: {
        id: result.membershipId,
        planName: result.planName,
        pricePaid: result.pricePaid,
        expiresAt: result.expiresAt.toISOString(),
        walletCredited: result.walletCredited,
        invoiceNumber: result.invoiceNumber,
      },
    }
  } catch (e) {
    return fail(e, 'purchase')
  }
}

/**
 * Cancel an active membership. Benefits stop immediately; the row is kept,
 * because the customer paid for it.
 */
export async function cancelCustomerMembership(
  membershipId: string,
  customerId: string,
): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to cancel memberships.')
    }
    const id = z.string().uuid('That membership reference is not valid.').parse(membershipId)

    await withUser(ctx.user.id, (tx) => cancelMembership(tx, ctx.tenant.id, id))

    revalidatePath(`/customers/${customerId}`)
    revalidatePath('/customers')
    return { success: true }
  } catch (e) {
    return fail(e, 'cancel')
  }
}
