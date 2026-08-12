import { Suspense } from 'react'
import { getActiveContext } from '@/lib/tenant/context'
import { listCustomers, PAGE_SIZE } from '@/lib/customers/data'
import { todayInZone } from '@/lib/booking/time'
import { prettyDate } from '@/lib/format'
import { CustomersView } from '@/components/customers/CustomersView'
import { CustomersListSkeleton } from '@/components/customers/CustomersListSkeleton'

type Search = { q?: string; page?: string; highlight?: string }

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const sp = await searchParams

  return (
    <Suspense key={`${sp.q ?? ''}|${sp.page ?? ''}`} fallback={<CustomersListSkeleton />}>
      <CustomersList search={sp} />
    </Suspense>
  )
}

async function CustomersList({ search }: { search: Search }) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const q = search.q?.trim() ?? ''
  const page = Number(search.page) > 0 ? Number(search.page) : 1

  const result = await listCustomers(ctx, { q, page })
  const tz = ctx.tenant.timezone

  return (
    <CustomersView
      rows={result.rows.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        membershipStatus: c.membershipStatus,
        tags: c.tags,
        createdLabel: prettyDate(todayInZone(tz, c.createdAt), tz),
      }))}
      total={result.total}
      totalUnfiltered={result.totalUnfiltered}
      page={result.page}
      pageCount={result.pageCount}
      pageSize={PAGE_SIZE}
      query={q}
      highlightId={search.highlight ?? null}
    />
  )
}
