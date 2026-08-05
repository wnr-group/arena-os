export function CustomersListSkeleton() {
  return (
    <div className="px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
          <div className="mt-2 h-4 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
      </div>

      <div className="mt-6 h-9 max-w-sm animate-pulse rounded-md bg-muted" />

      <div className="mt-4 overflow-hidden rounded-lg border">
        <div className="h-9 border-b bg-muted/40" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="mt-4 h-4 w-44 animate-pulse rounded bg-muted" />
    </div>
  )
}
