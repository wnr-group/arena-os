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
  branchName,
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
  branchName: string
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
        <p className="mt-1 text-sm text-muted-foreground">{branchName}</p>
      </div>

      {walkinEnabled && (
        <div className="mt-6 inline-flex rounded-xl border border-border bg-muted/60 p-1">
          <TabButton active={tab === 'walkin'} onClick={() => setTab('walkin')} icon={<Zap size={15} />}>
            Walk-in
          </TabButton>
          <TabButton active={tab === 'future'} onClick={() => setTab('future')} icon={<CalendarClock size={15} />}>
            Future booking
          </TabButton>
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

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition ${
        active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}
