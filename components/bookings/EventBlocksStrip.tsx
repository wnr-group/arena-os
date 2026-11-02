import { CalendarClock } from 'lucide-react'
import { timeInZone } from '@/lib/format'

export type EventBlockRow = {
  eventId: string
  title: string
  startsAt: string
  endsAt: string
  resourceNames: string[]
}

/**
 * Stations held by an event in the viewed window. Event blocks have no booking,
 * so the booking lists never show them; this keeps a station under an event from
 * looking idle (staff would otherwise only learn why from a failed Start).
 */
export function EventBlocksStrip({ blocks, timeZone }: { blocks: EventBlockRow[]; timeZone: string }) {
  if (blocks.length === 0) return null
  return (
    <section
      aria-label="Events holding stations"
      className="mx-auto mb-4 max-w-6xl rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-300">
        <CalendarClock size={15} aria-hidden /> Held for events
      </h2>
      <ul className="mt-2 space-y-1 text-sm">
        {blocks.map((b) => (
          <li key={b.eventId} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{b.title}</span>
            <span className="text-muted-foreground">
              {timeInZone(b.startsAt, timeZone)}–{timeInZone(b.endsAt, timeZone)} · {b.resourceNames.join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
