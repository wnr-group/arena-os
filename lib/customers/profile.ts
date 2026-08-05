import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import {
  customers,
  customerNotes,
  memberships,
  bookings,
  bookingSlots,
  walletTransactions,
  loyaltyTransactions,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { walletBalance, loyaltyPoints } from './ledger'

/**
 * Everything the customer profile renders, loaded in ONE RLS-scoped transaction.
 */

/** How much history the profile shows before it needs its own paged view. */
export const HISTORY_LIMIT = 20
export const LEDGER_LIMIT = 10

export type ProfileBooking = {
  id: string
  bookingNumber: string
  status: string
  source: string
  total: string
  createdAt: Date
  startsAt: Date | null
  endsAt: Date | null
  resources: string[]
  minutes: number
}

export type ProfileNote = {
  id: string
  body: string
  createdAt: Date
  createdByName: string | null
}

export type WalletEntry = {
  id: string
  amount: string
  reason: string | null
  sourceType: string | null
  createdAt: Date
}

export type LoyaltyEntry = {
  id: string
  points: number
  reason: string | null
  sourceType: string | null
  createdAt: Date
}

export type CustomerProfileData = {
  customer: typeof customers.$inferSelect
  stats: {
    totalBookings: number
    totalVisits: number
    walletBalance: number
    loyaltyPoints: number
  }
  bookings: ProfileBooking[]
  notes: ProfileNote[]
  wallet: WalletEntry[]
  loyalty: LoyaltyEntry[]
}

/**
 * Load a customer profile, or null when the id does not exist IN THIS TENANT —
 * which RLS makes indistinguishable from "does not exist at all".
 */
export async function getCustomerProfile(
  ctx: ActiveContext,
  customerId: string,
): Promise<CustomerProfileData | null> {
  const tenantId = ctx.tenant.id

  return withUser(ctx.user.id, async (tx) => {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1)

    if (!customer) return null

    const forCustomer = and(
      eq(bookings.tenantId, tenantId),
      eq(bookings.customerId, customerId),
    )

    // Both counts in one pass. A "visit" is a booking the customer actually
    // turned up for — checked in or completed — so cancellations and no-shows
    // count as bookings but not as visits.
    const [counts] = await tx
      .select({
        totalBookings: sql<number>`count(*)::int`,
        totalVisits: sql<number>`count(*) filter (
          where ${bookings.status} in ('checked_in','completed')
        )::int`,
      })
      .from(bookings)
      .where(forCustomer)

    const bookingRows = await tx
      .select({
        id: bookings.id,
        bookingNumber: bookings.bookingNumber,
        status: bookings.status,
        source: bookings.source,
        total: bookings.total,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .where(forCustomer)
      .orderBy(desc(bookings.createdAt))
      .limit(HISTORY_LIMIT)

    // Slots for every listed booking in a single round trip.
    const slotRows = bookingRows.length
      ? await tx
          .select({
            bookingId: bookingSlots.bookingId,
            resourceName: bookingSlots.resourceName,
            startsAt: bookingSlots.startsAt,
            endsAt: bookingSlots.endsAt,
          })
          .from(bookingSlots)
          .where(
            and(
              eq(bookingSlots.tenantId, tenantId),
              inArray(
                bookingSlots.bookingId,
                bookingRows.map((b) => b.id),
              ),
            ),
          )
      : []

    const slotsByBooking = new Map<string, typeof slotRows>()
    for (const s of slotRows) {
      const list = slotsByBooking.get(s.bookingId)
      if (list) list.push(s)
      else slotsByBooking.set(s.bookingId, [s])
    }

    const history: ProfileBooking[] = bookingRows.map((b) => {
      const slots = slotsByBooking.get(b.id) ?? []
      const minutes = slots.reduce(
        (sum, s) => sum + (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000,
        0,
      )
      const starts = slots.map((s) => s.startsAt.getTime())
      const ends = slots.map((s) => s.endsAt.getTime())
      return {
        ...b,
        resources: [...new Set(slots.map((s) => s.resourceName))],
        minutes: Math.round(minutes),
        startsAt: starts.length ? new Date(Math.min(...starts)) : null,
        endsAt: ends.length ? new Date(Math.max(...ends)) : null,
      }
    })

    // Notes carry the membership that wrote them; left-join so a note survives
    // its author leaving the team (created_by is ON DELETE SET NULL).
    const notes = await tx
      .select({
        id: customerNotes.id,
        body: customerNotes.body,
        createdAt: customerNotes.createdAt,
        createdByName: memberships.fullName,
      })
      .from(customerNotes)
      .leftJoin(memberships, eq(memberships.id, customerNotes.createdBy))
      .where(
        and(eq(customerNotes.tenantId, tenantId), eq(customerNotes.customerId, customerId)),
      )
      .orderBy(desc(customerNotes.createdAt))

    const wallet = await tx
      .select({
        id: walletTransactions.id,
        amount: walletTransactions.amount,
        reason: walletTransactions.reason,
        sourceType: walletTransactions.sourceType,
        createdAt: walletTransactions.createdAt,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.tenantId, tenantId),
          eq(walletTransactions.customerId, customerId),
        ),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(LEDGER_LIMIT)

    const loyalty = await tx
      .select({
        id: loyaltyTransactions.id,
        points: loyaltyTransactions.points,
        reason: loyaltyTransactions.reason,
        sourceType: loyaltyTransactions.sourceType,
        createdAt: loyaltyTransactions.createdAt,
      })
      .from(loyaltyTransactions)
      .where(
        and(
          eq(loyaltyTransactions.tenantId, tenantId),
          eq(loyaltyTransactions.customerId, customerId),
        ),
      )
      .orderBy(desc(loyaltyTransactions.createdAt))
      .limit(LEDGER_LIMIT)

    // Balances are summed over the WHOLE ledger by the canonical helpers in
    // ./ledger.ts — never over the truncated lists above, and never read from a
    // stored column, because no such column exists (migration 0006).
    const [balance, points] = await Promise.all([
      walletBalance(tx, tenantId, customerId),
      loyaltyPoints(tx, tenantId, customerId),
    ])

    return {
      customer,
      stats: {
        totalBookings: counts?.totalBookings ?? 0,
        totalVisits: counts?.totalVisits ?? 0,
        walletBalance: balance,
        loyaltyPoints: points,
      },
      bookings: history,
      notes,
      wallet,
      loyalty,
    }
  })
}
