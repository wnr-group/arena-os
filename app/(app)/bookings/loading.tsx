/**
 * Route-level skeleton for /bookings. A last-year range query takes a moment;
 * this keeps the page from looking frozen while the server renders.
 */
export default function BookingsLoading() {
  return (
    <div className="px-6 py-6" aria-busy="true" aria-label="Loading bookings" role="status">
      <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
      <div className="mt-2 h-4 w-64 animate-pulse rounded bg-muted" />

      <div className="-mx-6 mt-4 flex gap-2 overflow-hidden px-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 w-24 shrink-0 animate-pulse rounded-full bg-muted" />
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 w-24 animate-pulse rounded-full bg-muted" />
        ))}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border">
        {Array.from({ length: 2 }).map((_, g) => (
          <div key={g}>
            <div className="border-b bg-muted/40 px-4 py-2">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            </div>
            <div className="divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-2 px-4 py-3">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
