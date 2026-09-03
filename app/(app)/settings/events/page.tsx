import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import {
  listEvents,
  listEventBranches,
  listBookableResources,
  listEventResourceSelections,
  listEventSeries,
} from '@/lib/events/data'
import { getEventEntrantCounts } from '@/lib/events/registrations'
import { EventsManager } from '@/components/events/EventsManager'
import { EventSeriesManager } from '@/components/events/EventSeriesManager'

/**
 * Event management (M15 #1).
 *
 * Manager-gated three times over, deliberately: this redirect keeps the page
 * out of a cashier's hands, requireManager() in lib/actions/events.ts rejects
 * their mutations, and the events_manager_write policy (0078) refuses the write
 * at the database even if both were bypassed.
 */
export default async function EventsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [events, branches, entrantCounts, bookableResources, selections, series] = await Promise.all([
    listEvents(ctx),
    listEventBranches(ctx),
    // Counted with the SAME occupancy rule the capacity guard uses, so the
    // number a manager reads is the number the database will decide by.
    getEventEntrantCounts(ctx),
    // M15 #4 — the resource picker, and what each event already claims.
    listBookableResources(ctx),
    listEventResourceSelections(ctx),
    // M15 #8 — the recurring templates. Occurrences are ordinary events and
    // already appear in the list above; this manages what generates them.
    listEventSeries(ctx),
  ])

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Events</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Tournaments, classes, meetups, watch parties and private parties — tenant-scoped and manager only.
      </p>
      <EventsManager
        currency={ctx.tenant.currency}
        timezone={ctx.tenant.timezone}
        branches={branches}
        resources={bookableResources}
        events={events.map((e) => ({
          id: e.id,
          branchId: e.branchId,
          branchName: e.branchName,
          title: e.title,
          type: e.type,
          description: e.description,
          bannerUrl: e.bannerUrl,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          capacity: e.capacity,
          entryFee: e.entryFee,
          tournamentFormat: e.tournamentFormat,
          registrationMode: e.registrationMode,
          teamSize: e.teamSize,
          status: e.status,
          resourceScope: e.resourceScope,
          resourceIds: selections.get(e.id) ?? [],
          entrantCount: entrantCounts.get(e.id) ?? 0,
        }))}
      />

      <EventSeriesManager series={series} branches={branches} />
    </div>
  )
}
