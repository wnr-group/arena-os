'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Plus, Search, UserPlus, X } from 'lucide-react'
import { NewCustomerDialog } from './NewCustomerDialog'

export type CustomerRow = {
  id: string
  name: string | null
  phone: string
  email: string | null
  membershipStatus: string | null
  tags: string[]
  createdLabel: string
}

/** Debounce so typing a name doesn't fire a server round-trip per keystroke. */
const SEARCH_DEBOUNCE_MS = 300

export function CustomersView({
  rows,
  total,
  totalUnfiltered,
  page,
  pageCount,
  pageSize,
  query,
  highlightId,
}: {
  rows: CustomerRow[]
  total: number
  totalUnfiltered: number
  page: number
  pageCount: number
  pageSize: number
  query: string
  highlightId: string | null
}) {
  const router = useRouter()
  const [term, setTerm] = useState(query)
  const [showNew, setShowNew] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // Keep the box in step when the URL changes from outside (back button, or the
  // search being cleared after adding a customer).
  const applied = useRef(query)
  useEffect(() => {
    if (applied.current !== query) {
      applied.current = query
      setTerm(query)
    }
  }, [query])

  // Push the term into the URL, so the server does the filtering and the result
  // is shareable and survives a refresh — same approach as ?date= on Bookings.
  useEffect(() => {
    if (term === applied.current) return
    const t = setTimeout(() => {
      applied.current = term
      start(() => {
        router.replace(term.trim() ? `/customers?q=${encodeURIComponent(term.trim())}` : '/customers')
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [term, router])

  const searching = query.length > 0
  const noCustomersAtAll = totalUnfiltered === 0
  const noMatches = total === 0 && !noCustomersAtAll

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  const pageHref = (p: number) =>
    `/customers?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`

  function openDialog() {
    setNotice(null)
    setShowNew(true)
  }

  return (
    <div className="px-6 py-6">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalUnfiltered === 0
              ? 'No customers yet'
              : `${totalUnfiltered} customer${totalUnfiltered === 1 ? '' : 's'}`}
            {searching && ` · ${total} matching “${query}”`}
          </p>
        </div>
        <button
          onClick={openDialog}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus size={16} /> Add customer
        </button>
      </div>

      {notice && (
        <p className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">{notice}</p>
      )}

      {/* search */}
      {!noCustomersAtAll && (
        <div className="relative mt-6 max-w-sm">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search by name or phone"
            aria-label="Search customers by name or phone"
            className="w-full rounded-md border bg-background py-2 pl-9 pr-9 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {term && (
            <button
              onClick={() => setTerm('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* list */}
      {noCustomersAtAll ? (
        <EmptyDirectory onAdd={openDialog} />
      ) : noMatches ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No customers match <span className="font-medium text-foreground">“{query}”</span>.
          </p>
          <button
            onClick={() => setTerm('')}
            className="mt-3 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Clear search
          </button>
        </div>
      ) : (
        <>
          <div
            className={`mt-4 overflow-x-auto rounded-lg border transition-opacity ${
              pending ? 'opacity-60' : ''
            }`}
          >
            <table className="w-full min-w-[720px] text-base">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-sm uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Phone</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Membership</th>
                  <th className="px-4 py-2.5 font-medium">Tags</th>
                  <th className="px-4 py-2.5 text-right font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b last:border-0 hover:bg-muted/40 ${
                      c.id === highlightId ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-medium">
                      {/* The name is the link target rather than the whole row,
                          so the cell text stays selectable and the link is
                          reachable by keyboard. */}
                      <Link href={`/customers/${c.id}`} className="hover:underline">
                        {c.name || (
                          <span className="font-normal text-muted-foreground">No name</span>
                        )}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{c.phone}</td>
                    <td className="px-4 py-3">
                      {c.email || <span className="text-muted-foreground">No email</span>}
                    </td>
                    <td className="px-4 py-3">
                      {c.membershipStatus ? (
                        <span className="rounded-full border px-2 py-0.5 text-xs capitalize">
                          {c.membershipStatus}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.tags.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {c.tags.slice(0, 3).map((t) => (
                            <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                              {t}
                            </span>
                          ))}
                          {c.tags.length > 3 && (
                            <span className="text-xs text-muted-foreground">
                              +{c.tags.length - 3}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-muted-foreground">
                      {c.createdLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* pagination */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Showing {first}–{last} of {total}
            </p>
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <PageLink href={pageHref(page - 1)} disabled={page <= 1} label="Previous page">
                  <ChevronLeft size={16} />
                </PageLink>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {pageCount}
                </span>
                <PageLink href={pageHref(page + 1)} disabled={page >= pageCount} label="Next page">
                  <ChevronRight size={16} />
                </PageLink>
              </div>
            )}
          </div>
        </>
      )}

      {showNew && (
        <NewCustomerDialog
          onClose={() => setShowNew(false)}
          onSaved={({ customerId, created, label }) => {
            setShowNew(false)
            setNotice(
              created
                ? `${label} added to your customers.`
                : `${label} is already a customer — showing their record.`,
            )
            // Drop any search and page so the record is visible on page 1
            // (newest first), and highlight it.
            applied.current = ''
            setTerm('')
            router.replace(`/customers?highlight=${customerId}`)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function EmptyDirectory({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mt-8 rounded-lg border border-dashed p-12 text-center">
      <UserPlus className="mx-auto text-muted-foreground" size={28} />
      <h2 className="mt-3 font-medium">No customers yet</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Customers are added automatically when you take a booking with a phone number — or add one
        here to get started.
      </p>
      <button
        onClick={onAdd}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        <Plus size={16} /> Add first customer
      </button>
    </div>
  )
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string
  disabled: boolean
  label: string
  children: React.ReactNode
}) {
  if (disabled) {
    return (
      <span aria-disabled className="rounded-md border p-2 opacity-40" aria-label={label}>
        {children}
      </span>
    )
  }
  return (
    <Link href={href} className="rounded-md border p-2 hover:bg-muted" aria-label={label}>
      {children}
    </Link>
  )
}
