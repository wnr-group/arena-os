import { notFound } from 'next/navigation'
import { z } from 'zod'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes, getPublicAvailableStarts } from '@/lib/booking/public-availability'
import { todayInZone } from '@/lib/booking/time'
import { timeInZone, prettyDate } from '@/lib/format'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  other: 'Business',
}

const DURATIONS = [30, 60, 90, 120]

const query = z.object({
  resourceId: z.string().uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  duration: z.coerce.number().int().min(30).max(240).optional(),
})

export default async function PublicBookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // The layout already 404s an unknown/suspended subdomain — this repeats the
  // lookup, but getPublicTenantBySlug is React-cache'd per request, so it's
  // the same underlying query, not a second round trip.
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const raw = await searchParams
  const v = query.safeParse({
    resourceId: typeof raw.resourceId === 'string' ? raw.resourceId : undefined,
    date: typeof raw.date === 'string' ? raw.date : undefined,
    duration: typeof raw.duration === 'string' ? raw.duration : undefined,
  })

  const branch = await getPublicBranch(tenant.id)
  if (!branch) {
    return (
      <Shell tenant={tenant}>
        <p className="text-sm text-muted-foreground">
          Online booking isn&apos;t set up for this venue yet.
        </p>
      </Shell>
    )
  }

  const resourceTypes = await getPublicResourceTypes(tenant.id, branch.id)
  const allResources = resourceTypes.flatMap((t) => t.resources.map((r) => ({ ...r, typeName: t.name })))

  const date = v.success && v.data.date ? v.data.date : todayInZone(tenant.timezone)
  const durationMinutes = v.success && v.data.duration ? v.data.duration : 60
  const selected = v.success && v.data.resourceId ? allResources.find((r) => r.id === v.data.resourceId) : undefined

  const availability = selected
    ? await getPublicAvailableStarts({
        tenantId: tenant.id,
        branchId: branch.id,
        resourceId: selected.id,
        timeZone: tenant.timezone,
        date,
        durationMinutes,
      })
    : null

  return (
    <Shell tenant={tenant}>
      {resourceTypes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is bookable here yet — check back soon.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[1fr_1.4fr]">
          <div className="space-y-4">
            {resourceTypes.map((t) => (
              <div key={t.id} className="rounded-xl border border-border bg-card p-4">
                <p className="font-semibold">{t.name}</p>
                {t.description && <p className="mt-0.5 text-sm text-muted-foreground">{t.description}</p>}
                {t.capacity && <p className="mt-0.5 text-xs text-muted-foreground">Up to {t.capacity}</p>}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {t.resources.map((r) => (
                    <a
                      key={r.id}
                      href={`?resourceId=${r.id}&date=${date}&duration=${durationMinutes}`}
                      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                        selected?.id === r.id
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                      }`}
                    >
                      {r.name}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            {!selected ? (
              <p className="text-sm text-muted-foreground">Pick a resource to see open slots.</p>
            ) : (
              <>
                <form method="get" className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="resourceId" value={selected.id} />
                  <label className="text-sm">
                    <span className="block text-xs font-medium text-muted-foreground">Date</span>
                    <input
                      type="date"
                      name="date"
                      defaultValue={date}
                      min={todayInZone(tenant.timezone)}
                      className="mt-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-xs font-medium text-muted-foreground">Duration</span>
                    <select
                      name="duration"
                      defaultValue={durationMinutes}
                      className="mt-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
                    >
                      {DURATIONS.map((m) => (
                        <option key={m} value={m}>
                          {m} min
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
                    Check
                  </button>
                </form>

                <p className="mt-4 text-sm font-medium">
                  {selected.typeName} — {selected.name} · {prettyDate(date, tenant.timezone)}
                </p>

                {!availability ? null : 'error' in availability ? (
                  <p className="mt-3 text-sm text-destructive">{availability.error}</p>
                ) : availability.starts.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">No open slots this day.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {availability.starts.map((s) => (
                      <span
                        key={s.toISOString()}
                        className="rounded-md border border-border px-2.5 py-1 text-sm tabular-nums"
                      >
                        {timeInZone(s, tenant.timezone)}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  )
}

function Shell({
  tenant,
  children,
}: {
  tenant: { name: string; industry: string }
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {INDUSTRY_LABELS[tenant.industry] ?? 'Business'}
      </p>
      <h1 className="mt-1 text-2xl font-bold">{tenant.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Pick a resource and see what&apos;s free.</p>
      <div className="mt-6">{children}</div>
    </div>
  )
}
