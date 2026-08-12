import 'server-only'
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import { withUser } from '@/db'
import { customers } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export const PAGE_SIZE = 20

export type CustomerListItem = {
  id: string
  name: string | null
  phone: string
  email: string | null
  membershipStatus: string | null
  tags: string[]
  createdAt: Date
}

export type CustomerPage = {
  rows: CustomerListItem[]
  total: number
  totalUnfiltered: number
  page: number
  pageCount: number
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function searchFilter(term: string): SQL | undefined {
  const trimmed = term.trim()
  if (!trimmed) return undefined

  const parts: SQL[] = [ilike(customers.name, `%${escapeLike(trimmed)}%`)]

  const digits = trimmed.replace(/\D/g, '')
  if (digits) {
    parts.push(ilike(customers.phone, `%${escapeLike(digits)}%`))
  }

  return or(...parts)
}


export async function listCustomers(
  ctx: ActiveContext,
  opts: { q?: string; page?: number; pageSize?: number } = {},
): Promise<CustomerPage> {
  const pageSize = opts.pageSize ?? PAGE_SIZE
  const q = opts.q?.trim() ?? ''

  // The explicit tenant_id predicate matches every other query in the codebase.
  // RLS is what GUARANTEES isolation; this narrows to idx_customers_tenant and
  // keeps the intent readable at the call site.
  const tenantFilter = eq(customers.tenantId, ctx.tenant.id)
  const where = and(tenantFilter, searchFilter(q))

  return withUser(ctx.user.id, async (tx) => {
    const [{ n: total }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(where)

    const [{ n: totalUnfiltered }] = q
      ? await tx.select({ n: sql<number>`count(*)::int` }).from(customers).where(tenantFilter)
      : [{ n: total }]

    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(Math.max(1, opts.page ?? 1), pageCount)

    const rows = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        membershipStatus: customers.membershipStatus,
        tags: customers.tags,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(where)
      .orderBy(desc(customers.createdAt), asc(customers.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return { rows, total, totalUnfiltered, page, pageCount }
  })
}
