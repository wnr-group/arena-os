'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Ticket,
  Loader2,
  ChevronRight,
  Clock,
  UtensilsCrossed,
  Gamepad2,
  CalendarClock,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { lookupMyBookings } from '@/lib/actions/my-bookings'
import { isValidPhone } from '@/lib/customers/phone'
import type { PublicOrderSummary, CustomerOrderStatus } from '@/lib/orders/public-status'
import type { PublicBookingSummary } from '@/lib/booking/public-status'

const ORDER_STATUS_LABEL: Record<CustomerOrderStatus, string> = {
  awaiting_payment: 'Confirming payment',
  placed: 'Placed',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  rejected: "Couldn't be accepted",
  cancelled: 'Cancelled',
}

const ORDER_STATUS_TONE: Record<CustomerOrderStatus, string> = {
  awaiting_payment: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  placed: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  preparing: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ready: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  served: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
}

const BOOKING_STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

const BOOKING_STATUS_TONE: Record<string, string> = {
  confirmed: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  checked_in: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  completed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  cancelled: 'bg-muted text-muted-foreground',
  no_show: 'bg-destructive/10 text-destructive',
}

function elapsedLabel(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / (24 * 60))}d ago`
}

function fmtSlotRange(startsAt: string, endsAt: string | null, timezone: string): string {
  const start = new Date(startsAt)
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
  }).format(start)
  const startTime = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(start)
  if (!endsAt) return `${dateLabel}, ${startTime}`
  const endTime = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(endsAt))
  return `${dateLabel}, ${startTime} – ${endTime}`
}

/**
 * The "My Booking" hub (site header, next to the cart) — a single phone
 * lookup that surfaces a customer's recent food orders AND device/resource
 * bookings side by side. Reached from PublicNavbar's "My Booking" button
 * (app/(public)/track). Phone-only, no OTP: see lookupMyBookings's doc
 * comment for the accepted trust trade-off that comes with that (no
 * accounts/M9 yet).
 */
export function MyBookingsClient({ timezone }: { timezone: string }) {
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<{ orders: PublicOrderSummary[]; bookings: PublicBookingSummary[] } | null>(
    null,
  )
  const [pending, startTransition] = useTransition()

  const phoneIsComplete = phone.length === 10
  const phoneIsValid = isValidPhone(phone)

  function handleSubmit() {
    setError(null)
    setResults(null)
    startTransition(async () => {
      const res = await lookupMyBookings({ phone })
      if ('error' in res) {
        setError(res.error)
        return
      }
      setResults(res)
    })
  }

  const hasSearched = results !== null
  const isEmpty = hasSearched && results.orders.length === 0 && results.bookings.length === 0

  return (
    <div className="mx-auto max-w-lg px-4 py-12 sm:px-6 sm:py-16">
      {/* Premium header */}
      <div className="text-center">
        <span className="relative mx-auto flex size-16 items-center justify-center rounded-2xl bg-gradient-to-tr from-primary to-primary-hover text-primary-foreground shadow-lg shadow-primary/25 ring-4 ring-primary/10">
          <Ticket size={28} />
          <span className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-background text-primary shadow ring-1 ring-border">
            <Sparkles size={12} />
          </span>
        </span>
        <h1 className="mt-5 text-2xl font-black tracking-tight bg-gradient-to-r from-foreground to-muted-foreground/80 bg-clip-text text-transparent">
          My Booking
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Enter your mobile number to view your food orders and device bookings, all in one place.
        </p>
      </div>

      {/* Phone entry card */}
      <div className="mt-7 overflow-hidden rounded-2xl border border-border/60 bg-card shadow-lg shadow-black/[0.03]">
        <div className="bg-gradient-to-r from-primary/8 via-transparent to-transparent px-5 py-4">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-primary">
            <ShieldCheck size={13} /> Quick &amp; secure lookup
          </span>
        </div>
        <div className="px-5 pb-5 pt-1">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-muted-foreground">Mobile number</span>
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))
                setResults(null)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && phoneIsValid && !pending) handleSubmit()
              }}
              maxLength={10}
              placeholder="10-digit mobile number"
              autoFocus
              className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>
          {phoneIsComplete && !phoneIsValid && (
            <p className="mt-2 text-sm text-destructive">Enter a valid 10-digit mobile number.</p>
          )}
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!phoneIsValid || pending}
            className="group relative mt-4 inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-primary py-3 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="absolute inset-0 h-full w-full -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-1000 ease-out group-hover:translate-x-full" />
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Looking up…' : 'Find my bookings'}
          </button>
        </div>
      </div>

      {/* Results */}
      {hasSearched && (
        <div className="mt-8 space-y-7">
          {isEmpty && (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No recent orders or bookings found for that number.
            </p>
          )}

          {results.orders.length > 0 && (
            <section>
              <SectionHeading icon={UtensilsCrossed} label="Food orders" count={results.orders.length} />
              <div className="mt-3 space-y-3">
                {results.orders.map((order) => (
                  <Link
                    key={order.orderId}
                    href={`/o/${order.orderId}`}
                    className="group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:bg-primary/5"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <UtensilsCrossed size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-foreground">Order #{order.orderNumber}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock size={11} /> {elapsedLabel(order.createdAt)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${ORDER_STATUS_TONE[order.status]}`}
                    >
                      {ORDER_STATUS_LABEL[order.status]}
                    </span>
                    <ChevronRight
                      size={16}
                      className="shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-primary"
                    />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results.bookings.length > 0 && (
            <section>
              <SectionHeading icon={Gamepad2} label="Device bookings" count={results.bookings.length} />
              <div className="mt-3 space-y-3">
                {results.bookings.map((booking) => (
                  <Link
                    key={booking.bookingToken}
                    href={`/b/${booking.bookingToken}`}
                    className="group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:bg-primary/5"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                      <Gamepad2 size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-foreground">
                        {booking.resourceNames.length > 0 ? booking.resourceNames.join(', ') : `Booking #${booking.bookingNumber}`}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <CalendarClock size={11} className="shrink-0" />
                        {booking.startsAt ? fmtSlotRange(booking.startsAt, booking.endsAt, timezone) : elapsedLabel(booking.createdAt)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${BOOKING_STATUS_TONE[booking.status] ?? 'bg-muted text-muted-foreground'}`}
                    >
                      {BOOKING_STATUS_LABEL[booking.status] ?? booking.status}
                    </span>
                    <ChevronRight
                      size={16}
                      className="shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-primary"
                    />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHeading({
  icon: Icon,
  label,
  count,
}: {
  icon: typeof UtensilsCrossed
  label: string
  count: number
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon size={13} />
      </span>
      <h2 className="text-sm font-black uppercase tracking-wide text-foreground">{label}</h2>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">{count}</span>
    </div>
  )
}
