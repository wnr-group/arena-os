/**
 * Placing a booking — the transactional core shared by the staff action
 * (lib/actions/bookings.ts, via withUser) and the public booking action
 * (lib/actions/public-booking.ts, via withPublicTenant). Takes a `tx` and an
 * explicit ctx, exactly like lib/orders/service.ts:createOrderCore — the
 * caller decides how the tenant/identity was established.
 */
import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { resources, resourceTypes, bookings, bookingSlots, orders, auditLog } from '@/db/schema'
import { durationHours } from './availability'
import { todayInZone } from './time'
import { resolveBookingCustomer } from './customer'
import { findLiveInvoice } from '@/lib/billing/invoice'

type Db = NodePgDatabase<typeof schema>

/** Booking rule violations the caller is allowed to show verbatim. */
export class BookingError extends Error {}

export type CreateBookingSlotInput = { resourceId: string; startsAt: string; endsAt: string }

export type CreateBookingInput = {
  branchId: string
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  notes?: string
  source: 'walk_in' | 'staff' | 'online'
  discount: number
  deposit: number
  slots: CreateBookingSlotInput[]
}

export type CreatedBooking = { id: string; bookingNumber: string; confirmationToken: string }

export type PricedBookingSlot = {
  resourceId: string
  startsAt: Date
  endsAt: Date
  rateApplied: string
  slotTotal: string
  resourceName: string
  resourceTypeName: string
}

/**
 * Price a set of slots against their resources' effective hourly rate —
 * split out of createBookingCore so a caller can learn a booking's total
 * BEFORE creating it (the public pay-now flow, lib/actions/public-booking.ts,
 * needs this to decide how much to charge online) without a second,
 * drifting copy of the rate lookup.
 */
export async function priceBookingSlots(
  tx: Db,
  ctx: { tenantId: string },
  input: { branchId: string; slots: CreateBookingSlotInput[] },
): Promise<{ subtotal: number; slots: PricedBookingSlot[] }> {
  for (const s of input.slots) {
    if (new Date(s.endsAt) <= new Date(s.startsAt)) {
      throw new BookingError('Each slot must end after it starts.')
    }
  }

  // Load the referenced resources + their type (name + effective rate).
  const ids = [...new Set(input.slots.map((s) => s.resourceId))]
  const rows = await tx
    .select({
      id: resources.id,
      name: resources.name,
      branchId: resources.branchId,
      typeName: resourceTypes.name,
      typeRate: resourceTypes.hourlyRate,
      rateOverride: resources.hourlyRateOverride,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), inArray(resources.id, ids)))

  const byId = new Map(rows.map((r) => [r.id, r]))
  if (byId.size !== ids.length) throw new BookingError('One or more resources were not found.')
  for (const r of rows) {
    if (r.branchId !== input.branchId) throw new BookingError('A resource belongs to a different branch.')
  }

  // Price each slot from a snapshot of the effective rate.
  let subtotal = 0
  const slots = input.slots.map((s) => {
    const r = byId.get(s.resourceId)!
    const rate = Number(r.rateOverride ?? r.typeRate)
    const hours = durationHours(new Date(s.startsAt), new Date(s.endsAt))
    const total = rate * hours
    subtotal += total
    return {
      resourceId: s.resourceId,
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
      rateApplied: rate.toFixed(2),
      slotTotal: total.toFixed(2),
      resourceName: r.name,
      resourceTypeName: r.typeName,
    }
  })

  return { subtotal, slots }
}

/**
 * Booking number: BK-YYYYMMDD-NNN, sequential per tenant per creation day.
 * Shared by createBookingCore (timed bookings) and seatTableSessionCore
 * (table sessions) so the two numbering schemes can never drift apart.
 *
 * ONE statement: the upsert takes a row lock on the (tenant, kind, period)
 * key against `sequences` (0018/0056 already allow kind = 'booking'), same
 * mechanism as lib/billing/invoice.ts:nextInvoiceNumber and
 * lib/orders/service.ts:nextDailyNumber — a read-then-write `count(*)` here
 * would hand two concurrent callers the same number and let
 * bookings_tenant_number_key reject the loser, which a walk-in-heavy screen
 * like seatTableSessionCore hits often enough at rush to matter.
 */
async function nextBookingNumber(tx: Db, ctx: { tenantId: string; timezone: string }): Promise<string> {
  const compact = todayInZone(ctx.timezone).replace(/-/g, '')
  const bumped = await tx.execute<{ value: number }>(sql`
    insert into sequences (tenant_id, kind, period, value)
    values (${ctx.tenantId}, 'booking', ${compact}, 1)
    on conflict (tenant_id, kind, period)
      do update set value = sequences.value + 1
    returning value
  `)
  const value = Number(bumped.rows[0].value)
  return `BK-${compact}-${String(value).padStart(3, '0')}`
}

export async function createBookingCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  const { subtotal, slots: slotRows } = await priceBookingSlots(tx, ctx, {
    branchId: input.branchId,
    slots: input.slots,
  })

  const total = Math.max(0, subtotal - input.discount)

  // Attach the booking to the customer directory so it shows on their
  // profile. Same transaction as the booking, so the two commit together.
  // Returns null when there's no usable phone — see resolveBookingCustomer.
  const customerId = await resolveBookingCustomer(tx, ctx.tenantId, {
    phone: input.customerPhone,
    name: input.customerName,
    email: input.customerEmail,
  })

  const bookingNumber = await nextBookingNumber(tx, ctx)

  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      bookingNumber,
      customerName: input.customerName || null,
      customerPhone: input.customerPhone || null,
      customerEmail: input.customerEmail || null,
      customerId,
      status: 'confirmed',
      source: input.source,
      subtotal: subtotal.toFixed(2),
      discount: input.discount.toFixed(2),
      total: total.toFixed(2),
      deposit: input.deposit.toFixed(2),
      notes: input.notes || null,
      createdBy: ctx.membershipId,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  // Insert slots — the exclusion constraint rejects any overlap atomically.
  await tx.insert(bookingSlots).values(
    slotRows.map((s) => ({
      tenantId: ctx.tenantId,
      bookingId: booking.id,
      ...s,
    })),
  )

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}

export type SeatTableSessionInput = {
  branchId: string
  resourceId: string
  coverCount: number
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  notes?: string
}

/**
 * Seat a walk-in party at a table — M17 #1. Unlike createBookingCore, this
 * skips priceBookingSlots and booking_slots entirely: a table session has no
 * time window to price or exclude on, so `bookings.resource_id` (0071) links
 * it to its table directly, and the booking starts life already
 * `checked_in` — a party is, definitionally, present the moment they're
 * seated. Concurrent double-seating of the same table is rejected by the DB
 * (idx_bookings_open_table_session, a partial unique index — see 0071), not
 * by a check-then-insert race here.
 */
export async function seatTableSessionCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: SeatTableSessionInput,
): Promise<CreatedBooking> {
  if (!Number.isInteger(input.coverCount) || input.coverCount <= 0) {
    throw new BookingError('Cover count must be a whole number greater than zero.')
  }

  const [resource] = await tx
    .select({ id: resources.id, branchId: resources.branchId, status: resources.status, hourlyRate: resourceTypes.hourlyRate })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.resourceId)))
    .limit(1)
  if (!resource) throw new BookingError('Table not found.')
  if (resource.branchId !== input.branchId) {
    throw new BookingError('Table belongs to a different branch.')
  }
  // The 0071 convention lib/booking/data.ts:listTables also follows: a
  // "table" is a resource whose type carries no hourly rate. Without this, a
  // resourceId belonging to a paid/timed resource type could open a table
  // session that bypasses its hourly billing model entirely and — since
  // listTables filters on this same condition — sits locked but invisible on
  // both /floor and the normal booking calendar.
  if (Number(resource.hourlyRate) !== 0) {
    throw new BookingError('This resource isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (resource.status !== 'available') throw new BookingError('This table is not available.')

  const customerId = await resolveBookingCustomer(tx, ctx.tenantId, {
    phone: input.customerPhone,
    name: input.customerName,
    email: input.customerEmail,
  })

  const bookingNumber = await nextBookingNumber(tx, ctx)
  const now = new Date()

  // idx_bookings_open_table_session rejects this with a unique-violation
  // (23505) if the table was seated by someone else a moment ago — the
  // caller (lib/actions/bookings.ts) turns that into a friendly message,
  // the same way it already does for booking_slots' overlap violation.
  const [booking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      resourceId: input.resourceId,
      coverCount: input.coverCount,
      bookingNumber,
      customerName: input.customerName || null,
      customerPhone: input.customerPhone || null,
      customerEmail: input.customerEmail || null,
      customerId,
      status: 'checked_in',
      source: 'walk_in',
      notes: input.notes || null,
      createdBy: ctx.membershipId,
      checkedInAt: now,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  return { id: booking.id, bookingNumber, confirmationToken: booking.confirmationToken }
}

// ── Table transfer / merge / split (M17 #5) ────────────────────────────────
//
// All three below move `bookings.resource_id` and/or `orders.booking_id`
// around, so each locks the row(s) it touches FOR UPDATE and re-validates
// against the locked state, then leans on idx_bookings_open_table_session
// (0071) to catch a destination that got occupied a moment ago — the same
// "let the constraint reject it" discipline seatTableSessionCore above uses,
// not a check-then-write race.

export type AuditActor = { tenantId: string; membershipId: string | null }

/** Append one audit row. Same shape as lib/billing/refunds.ts's private
 *  writeAudit — no shared audit module exists; each domain keeps its own. */
async function writeAudit(
  tx: Db,
  actor: AuditActor,
  entry: {
    action: string
    entityType: string
    entityId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorMembershipId: actor.membershipId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  })
}

async function lockTableSession(
  tx: Db,
  tenantId: string,
  bookingId: string,
  /** The past-tense verb for the "can't be X" message — 'moved' fits
   *  transfer/merge/split; requestBillCore passes 'billed' instead. */
  verb: string = 'moved',
): Promise<{
  id: string
  branchId: string
  resourceId: string | null
  coverCount: number | null
  status: string
}> {
  const [row] = await tx
    .select({
      id: bookings.id,
      branchId: bookings.branchId,
      resourceId: bookings.resourceId,
      coverCount: bookings.coverCount,
      status: bookings.status,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!row) throw new BookingError('Table session not found.')
  if (!row.resourceId) throw new BookingError('That booking is not a table session.')
  if (row.status !== 'checked_in') {
    throw new BookingError(`This table session is ${row.status.replace('_', ' ')} — it can't be ${verb}.`)
  }
  return row
}

/**
 * Flag a table session's bill as requested (M17 #2) — validated the same way
 * transferTableCore/mergeTablesCore/splitTableCore are: lockTableSession
 * confirms this is actually an active (checked_in) table session before the
 * write, instead of stamping bill_requested_at on a booking that isn't a
 * table session at all, or one that's already completed/cancelled and has no
 * floor-map meaning left for the flag.
 */
export async function requestBillCore(tx: Db, ctx: { tenantId: string }, bookingId: string): Promise<void> {
  await lockTableSession(tx, ctx.tenantId, bookingId, 'billed')
  await tx
    .update(bookings)
    .set({ billRequestedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)))
}

async function requireNoLiveInvoice(tx: Db, tenantId: string, bookingId: string): Promise<void> {
  const existing = await findLiveInvoice(tx, tenantId, bookingId)
  if (existing) {
    throw new BookingError(`This table has already been billed as invoice ${existing.invoiceNumber} — nothing to move.`)
  }
}

export type TransferTableInput = { bookingId: string; targetResourceId: string }

/** Move a table session to a different table. Its orders "come with it" for
 *  free — they key off bookings.id, which never changes here, only its
 *  resource_id does. */
export async function transferTableCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  input: TransferTableInput,
): Promise<{ resourceName: string }> {
  const session = await lockTableSession(tx, ctx.tenantId, input.bookingId)
  if (session.resourceId === input.targetResourceId) {
    throw new BookingError('Already seated at that table.')
  }
  await requireNoLiveInvoice(tx, ctx.tenantId, input.bookingId)

  const [fromResource] = await tx
    .select({ name: resources.name })
    .from(resources)
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, session.resourceId!)))
    .limit(1)

  const [target] = await tx
    .select({
      id: resources.id,
      branchId: resources.branchId,
      status: resources.status,
      name: resources.name,
      hourlyRate: resourceTypes.hourlyRate,
    })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.targetResourceId)))
    .limit(1)
  if (!target) throw new BookingError('Target table not found.')
  if (target.branchId !== session.branchId) throw new BookingError('Target table belongs to a different branch.')
  // Same table-type convention as seatTableSessionCore — see its comment.
  if (Number(target.hourlyRate) !== 0) {
    throw new BookingError('Target isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (target.status !== 'available') throw new BookingError('Target table is not available.')

  // idx_bookings_open_table_session rejects this (23505) if the target was
  // seated by someone else a moment ago — translated to a friendly message
  // by lib/actions/bookings.ts:fail(), same as seatTable's race.
  await tx
    .update(bookings)
    .set({ resourceId: target.id })
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, ctx, {
    action: 'transfer_table',
    entityType: 'booking',
    entityId: input.bookingId,
    before: { resourceId: session.resourceId, resourceName: fromResource?.name ?? null },
    after: { resourceId: target.id, resourceName: target.name },
  })

  return { resourceName: target.name }
}

export type MergeTablesInput = { intoBookingId: string; fromBookingId: string }

/** Fold one table session into another: all of "from"'s open orders move to
 *  "into", cover counts sum, and "from" closes (completed) — freeing its
 *  table via idx_bookings_open_table_session the same way "Mark table free"
 *  already does. */
export async function mergeTablesCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  input: MergeTablesInput,
): Promise<{ movedOrderCount: number }> {
  if (input.intoBookingId === input.fromBookingId) {
    throw new BookingError('Pick two different tables to merge.')
  }

  // Lock both rows in a fixed order (by id) so a concurrent reverse merge
  // can't deadlock against this one.
  const [firstId, secondId] =
    input.intoBookingId < input.fromBookingId
      ? [input.intoBookingId, input.fromBookingId]
      : [input.fromBookingId, input.intoBookingId]
  const first = await lockTableSession(tx, ctx.tenantId, firstId)
  const second = await lockTableSession(tx, ctx.tenantId, secondId)
  const into = first.id === input.intoBookingId ? first : second
  const from = first.id === input.fromBookingId ? first : second

  if (into.branchId !== from.branchId) {
    throw new BookingError('Both tables must be in the same branch to merge.')
  }
  await requireNoLiveInvoice(tx, ctx.tenantId, into.id)
  await requireNoLiveInvoice(tx, ctx.tenantId, from.id)

  const moved = await tx
    .update(orders)
    .set({ bookingId: into.id })
    .where(and(eq(orders.bookingId, from.id), eq(orders.tenantId, ctx.tenantId), eq(orders.status, 'open')))
    .returning({ id: orders.id })

  const combinedCovers = (into.coverCount ?? 0) + (from.coverCount ?? 0)
  await tx
    .update(bookings)
    .set({ coverCount: combinedCovers })
    .where(and(eq(bookings.id, into.id), eq(bookings.tenantId, ctx.tenantId)))

  const now = new Date()
  await tx
    .update(bookings)
    .set({ status: 'completed', completedAt: now })
    .where(and(eq(bookings.id, from.id), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, ctx, {
    action: 'merge_tables_into',
    entityType: 'booking',
    entityId: into.id,
    before: { coverCount: into.coverCount },
    after: { coverCount: combinedCovers, mergedFromBookingId: from.id, movedOrderIds: moved.map((o) => o.id) },
  })
  await writeAudit(tx, ctx, {
    action: 'merge_tables_from',
    entityType: 'booking',
    entityId: from.id,
    before: { status: 'checked_in', coverCount: from.coverCount },
    after: { status: 'completed', mergedIntoBookingId: into.id },
  })

  return { movedOrderCount: moved.length }
}

export type SplitTableInput = {
  sourceBookingId: string
  targetResourceId: string
  orderIds: string[]
  coverCount: number
}

/** Split a subset of a table session's open orders onto a brand-new session
 *  on a different (currently free) table — a second, separate tab for the
 *  same visit. Bill-level splitting of one tab's payment is a later
 *  milestone (M18); this only ever moves whole orders. */
export async function splitTableCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: SplitTableInput,
): Promise<CreatedBooking & { movedOrderCount: number }> {
  const source = await lockTableSession(tx, ctx.tenantId, input.sourceBookingId)
  await requireNoLiveInvoice(tx, ctx.tenantId, input.sourceBookingId)

  // Checked against the LOCKED cover count, not whatever the dialog last
  // rendered: a merge/edit landing between the dialog opening and this
  // running could have changed it. A split needs someone to move AND
  // someone to stay, so anything under 2 has no valid split at all — this
  // is the authoritative gate; SplitTableDialog/FloorView only pre-empt it
  // in the UI so a waiter isn't let all the way to a rejected submit.
  const sourceCovers = source.coverCount ?? 0
  if (sourceCovers < 2) {
    throw new BookingError('This table needs at least 2 guests to split.')
  }

  if (!Number.isInteger(input.coverCount) || input.coverCount < 1) {
    throw new BookingError('Cover count must be a whole number of at least 1.')
  }
  if (input.coverCount >= sourceCovers) {
    throw new BookingError('At least one guest must stay at the original table — that would move everyone.')
  }

  const [customer] = await tx
    .select({
      customerId: bookings.customerId,
      customerName: bookings.customerName,
      customerPhone: bookings.customerPhone,
      customerEmail: bookings.customerEmail,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.sourceBookingId), eq(bookings.tenantId, ctx.tenantId)))
    .limit(1)

  const [target] = await tx
    .select({ id: resources.id, branchId: resources.branchId, status: resources.status, hourlyRate: resourceTypes.hourlyRate })
    .from(resources)
    .innerJoin(resourceTypes, eq(resourceTypes.id, resources.resourceTypeId))
    .where(and(eq(resources.tenantId, ctx.tenantId), eq(resources.id, input.targetResourceId)))
    .limit(1)
  if (!target) throw new BookingError('Target table not found.')
  if (target.branchId !== source.branchId) throw new BookingError('Target table belongs to a different branch.')
  // Same table-type convention as seatTableSessionCore — see its comment.
  if (Number(target.hourlyRate) !== 0) {
    throw new BookingError('Target isn’t set up as a table — use a resource type with no hourly rate.')
  }
  if (target.status !== 'available') throw new BookingError('Target table is not available.')

  const bookingNumber = await nextBookingNumber(tx, ctx)
  const now = new Date()

  // idx_bookings_open_table_session rejects this (23505) if the target was
  // seated by someone else a moment ago, same as seatTableSessionCore.
  const [newBooking] = await tx
    .insert(bookings)
    .values({
      tenantId: ctx.tenantId,
      branchId: source.branchId,
      resourceId: target.id,
      coverCount: input.coverCount,
      bookingNumber,
      customerName: customer?.customerName ?? null,
      customerPhone: customer?.customerPhone ?? null,
      customerEmail: customer?.customerEmail ?? null,
      customerId: customer?.customerId ?? null,
      status: 'checked_in',
      source: 'walk_in',
      createdBy: ctx.membershipId,
      checkedInAt: now,
    })
    .returning({ id: bookings.id, confirmationToken: bookings.confirmationToken })

  let movedOrderCount = 0
  if (input.orderIds.length > 0) {
    const moved = await tx
      .update(orders)
      .set({ bookingId: newBooking.id })
      .where(
        and(
          inArray(orders.id, input.orderIds),
          eq(orders.bookingId, input.sourceBookingId),
          eq(orders.tenantId, ctx.tenantId),
          eq(orders.status, 'open'),
        ),
      )
      .returning({ id: orders.id })
    if (moved.length !== input.orderIds.length) {
      throw new BookingError('One of the selected orders is no longer open — reload and try again.')
    }
    movedOrderCount = moved.length
  }

  await tx
    .update(bookings)
    .set({ coverCount: sourceCovers - input.coverCount })
    .where(and(eq(bookings.id, input.sourceBookingId), eq(bookings.tenantId, ctx.tenantId)))

  await writeAudit(tx, ctx, {
    action: 'split_table_from',
    entityType: 'booking',
    entityId: input.sourceBookingId,
    before: { coverCount: sourceCovers },
    after: { coverCount: sourceCovers - input.coverCount, splitToBookingId: newBooking.id, movedOrderIds: input.orderIds },
  })
  await writeAudit(tx, ctx, {
    action: 'split_table_into',
    entityType: 'booking',
    entityId: newBooking.id,
    before: {},
    after: { coverCount: input.coverCount, splitFromBookingId: input.sourceBookingId, resourceId: target.id },
  })

  return { id: newBooking.id, bookingNumber, confirmationToken: newBooking.confirmationToken, movedOrderCount }
}
