'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarClock, Zap } from 'lucide-react'
import { WalkinWizard } from './WalkinWizard'
import { FutureWizard } from './FutureWizard'

export type WizardResource = {
  id: string
  name: string
  resourceTypeId: string
  typeName: string
  imageUrl: string | null
  /** The resource type's own hourly rate (rupees) — same figure the public
   *  booking site shows per duration; ignores any per-unit override since a
   *  type-level booking can't know which unit it'll land on yet. */
  hourlyRate: string
  capacity: number | null
}

/**
 * Full-page "New booking" shell (M21 #3) — the premium replacement for the
 * old in-place modal. Two tabs, each a multi-step wizard; picking a tab is
 * purely presentational, same as before: startWalkin/createBooking each
 * re-validate everything server-side regardless of which tab got you there.
 */
export function BookingWizard({
  branchId,
  timeZone,
  currency,
  today,
  initialDate,
  initialTab,
  initialResourceTypeId,
  resources,
  walkinEnabled,
}: {
  branchId: string
  timeZone: string
  currency: string
  today: string
  initialDate: string
  initialTab: 'walkin' | 'future'
  initialResourceTypeId?: string
  resources: WizardResource[]
  walkinEnabled: boolean
}) {
  const [tab, setTab] = useState<'walkin' | 'future'>(initialTab)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft size={16} /> Back to bookings
      </Link>

      <div className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">New booking</h1>
      </div>

      {walkinEnabled && (
        <div className="mx-auto mt-6 grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
          <ModeCard
            selected={tab === 'walkin'}
            onClick={() => setTab('walkin')}
            icon={<Zap size={20} />}
            title="Walk-in"
            description="A customer is here right now — start their session in a couple of taps."
          />
          <ModeCard
            selected={tab === 'future'}
            onClick={() => setTab('future')}
            icon={<CalendarClock size={20} />}
            title="Future booking"
            description="Reserve a date, duration and time slot for later."
          />
        </div>
      )}

      <div className="mt-6">
        {tab === 'walkin' && walkinEnabled ? (
          <WalkinWizard branchId={branchId} timeZone={timeZone} currency={currency} />
        ) : (
          <FutureWizard
            branchId={branchId}
            timeZone={timeZone}
            currency={currency}
            today={today}
            initialDate={initialDate}
            initialResourceTypeId={initialResourceTypeId}
            resources={resources}
          />
        )}
      </div>
    </div>
  )
}

/** A premium, self-describing tile for the Walk-in/Future-booking choice —
 *  the same selected-tile treatment components/bookings/new/wizard-ui.tsx's
 *  SelectableTile uses elsewhere in this wizard, sized up with room for a
 *  one-line description since this is the very first decision in the flow. */
function ModeCard({
  selected,
  onClick,
  icon,
  title,
  description,
}: {
  selected: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`group relative flex items-start gap-3 rounded-2xl border p-4 text-left transition-all duration-200 motion-safe:hover:-translate-y-0.5 ${
        selected
          ? 'border-primary bg-accent/60 shadow-[0_4px_16px_-6px_rgba(139,34,66,0.35)] ring-1 ring-primary/30'
          : 'border-border bg-card hover:border-primary/40 hover:shadow-sm'
      }`}
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
          selected ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className={`block text-sm font-semibold ${selected ? 'text-primary' : 'text-foreground'}`}>{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      {selected && (
        <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <svg viewBox="0 0 20 20" fill="currentColor" className="size-3">
            <path
              fillRule="evenodd"
              d="M16.704 5.29a1 1 0 010 1.415l-7.5 7.5a1 1 0 01-1.415 0l-3.5-3.5a1 1 0 111.415-1.414L8.5 12.086l6.79-6.796a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      )}
    </button>
  )
}
