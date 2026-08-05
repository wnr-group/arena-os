/**
 customer profile
 */
export default function CustomerProfileLoading() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="h-4 w-28 animate-pulse rounded bg-muted" />

      <div className="mt-4 flex items-start gap-4">
        <div className="h-14 w-14 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="flex-1">
          <div className="h-7 w-52 animate-pulse rounded-md bg-muted" />
          <div className="mt-2 h-4 w-64 animate-pulse rounded bg-muted" />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-4 w-28 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-4">
            <div className="h-4 w-4 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-6 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="mt-8 h-3 w-32 animate-pulse rounded bg-muted" />
      <div className="mt-3 overflow-hidden rounded-lg border">
        <div className="h-9 border-b bg-muted/40" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
