/**
 * M33 — resource add-ons: optional priced, stock-limited extras (camera, lens,
 * extra equipment) rented alongside a booking slot.
 *
 * Catalog: resource_type_addons — per resource type, STOCK pooled per branch.
 * Line items: booking_addons — both the stock reservation and the billing
 * line. Everything here takes a `tx` and runs in the caller's transaction, same
 * as lib/booking/service.ts, so a refused add-on rolls the whole booking back.
 *
 * Invariants (see 0108_resource_addons.sql):
 *   - Name / unit / rate are SNAPSHOTTED onto booking_addons at attach time;
 *     a catalog edit never reprices a live booking.
 *   - Stock = catalog.stock_quantity minus the overlapping-window sum of
 *     booking_addons.quantity, EXCLUDING cancelled / no-show bookings (a
 *     cancelled booking must not hold stock it never used).
 *   - Catalog rows are locked FOR UPDATE in a fixed order (by id) so two
 *     bookings attaching overlapping add-on sets can't deadlock.
 *   - line_total is computed once, at the booking's single pricing pass:
 *     creation for reserved/studio bookings, checkout for walk-ins.
 *   - booking_addons.ends_at is kept in lockstep with booking_slots.ends_at
 *     (syncSlotAddonEnds) at every site that writes the latter.
 *   - Daily-rate add-ons bill ceil(elapsed hours / 24) day-blocks (min 1).
 */
import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookingAddons, bookings, bookingSlots, resources, resourceTypeAddons } from '@/db/schema'
import { findLiveBilling } from '@/lib/billing/invoice'
import { round2 } from '@/lib/billing/pricing'
import { BookingError } from './booking-error'
import {
  ADDON_MAX_QUANTITY,
  addonBillableUnits,
  type AddonRateUnit,
  type AddonRequest,
} from './addon-pricing'

type Db = NodePgDatabase<typeof schema>

export { addonBillableUnits, ADDON_MAX_QUANTITY } from './addon-pricing'
export type { AddonRateUnit, AddonRequest } from './addon-pricing'

/** Bookings in these states hold no add-on stock (mirrors the slot `active`
 *  trigger in 0003: cancelled and no-show release the resource, so they
 *  release the add-ons too). */
const STOCK_RELEASING_STATUSES = ['cancelled', 'no_show'] as const

/** What a slot looks like to the add-on code. `endsAt` null = open tab. */
export type AddonSlotTarget = {
  slotId: string
  resourceTypeId: string
  startsAt: Date
  endsAt: Date | null
  addons: AddonRequest[]
}

export function addonLineTotal(
  rateUnit: AddonRateUnit,
  rate: number,
  quantity: number,
  startsAt: Date,
  endsAt: Date,
): number {
  return round2(rate * quantity * addonBillableUnits(rateUnit, startsAt, endsAt))
}

/** Normalise + validate a request list: positive whole quantities, duplicates
 *  of one add-on merged. Throws a BookingError safe to show verbatim. */
export function normalizeAddonRequests(requests: AddonRequest[] | undefined): AddonRequest[] {
  const merged = new Map<string, number>()
  for (const r of requests ?? []) {
    if (!Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > ADDON_MAX_QUANTITY) {
      throw new BookingError(`Add-on quantity must be a whole number between 1 and ${ADDON_MAX_QUANTITY}.`)
    }
    merged.set(r.addonId, (merged.get(r.addonId) ?? 0) + r.quantity)
  }
  for (const q of merged.values()) {
    if (q > ADDON_MAX_QUANTITY) throw new BookingError(`Add-on quantity can't exceed ${ADDON_MAX_QUANTITY}.`)
  }
  return [...merged.entries()].map(([addonId, quantity]) => ({ addonId, quantity }))
}

/*
 * ════════════════════════════════════════════════════════════════════════════
 *  STOCK CHECK — READ THIS BEFORE TOUCHING booking_addons
 * ════════════════════════════════════════════════════════════════════════════
 *  Nothing in Postgres enforces add-on stock. The booking_slots GiST exclusion
 *  only forbids strictly overlapping ranges; it cannot express "the SUM of
 *  quantities over overlapping ranges must stay <= stock_quantity". The only
 *  thing standing between two concurrent bookings and an oversell is this
 *  discipline, and it must be followed by EVERY writer:
 *
 *    1. lockAddonCatalog(...)   — SELECT … FOR UPDATE the catalog row(s) the
 *                                 write touches, in ORDER BY id. The fixed
 *                                 order is what prevents a cross-booking
 *                                 deadlock (Tx1: Camera→Lens, Tx2: Lens→Camera)
 *                                 no matter what order the caller listed them.
 *    2. addonHeadroom(...)      — sum the overlapping booking_addons AFTER the
 *                                 lock is held (so a racing transaction's
 *                                 committed rows are visible), compare to
 *                                 stock_quantity.
 *    3. insert / update the booking_addons row in the SAME transaction.
 *
 *  Skip step 1 — or read headroom before taking the lock — and two bookings can
 *  both see "1 left" and both insert. Live availability reads (the pickers) are
 *  deliberately unlocked and advisory only; a commit path must never trust
 *  them. Any new code that inserts into, or lengthens the window of,
 *  booking_addons goes through attachAddonsToSlots / setSlotAddonsCore /
 *  syncSlotAddonEnds, which already do all three.
 *
 *  Overlap test: [a,b) and [c,d) overlap iff a < d and c < b. A NULL ends_at
 *  (an open-tab walk-in still running) is unbounded — same accepted tradeoff
 *  the resource's own GiST constraint has for an open tab. Cancelled and
 *  no-show bookings are excluded: a booking that never used its units must not
 *  hold them.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Units of `addonId` already reserved over [startsAt, endsAt) at this branch,
 * across every non-cancelled booking. `endsAt` null = an open tab: an
 * unbounded window, so every reservation that hasn't ended before startsAt
 * counts. A reservation with a null ends_at (an open tab still running)
 * counts against any window that starts after it did.
 *
 * `excludeBookingSlotId` leaves one slot's own rows out — the edit tool
 * re-checks a slot against everyone ELSE, not against itself.
 */
export async function reservedAddonUnits(
  tx: Db,
  tenantId: string,
  addonId: string,
  startsAt: Date,
  endsAt: Date | null,
  excludeBookingSlotId?: string,
): Promise<number> {
  const rows = await tx.execute<{ reserved: string }>(sql`
    select coalesce(sum(ba.quantity), 0)::int as reserved
      from booking_addons ba
      join bookings b on b.id = ba.booking_id
     where ba.tenant_id = ${tenantId}
       and ba.addon_id = ${addonId}
       and b.status not in (${sql.join(
         STOCK_RELEASING_STATUSES.map((s) => sql`${s}`),
         sql`, `,
       )})
       and (ba.ends_at is null or ba.ends_at > ${startsAt.toISOString()}::timestamptz)
       ${endsAt ? sql`and ba.starts_at < ${endsAt.toISOString()}::timestamptz` : sql``}
       ${excludeBookingSlotId ? sql`and ba.booking_slot_id <> ${excludeBookingSlotId}` : sql``}
  `)
  return Number(rows.rows[0]?.reserved ?? 0)
}

/**
 * Highest number of units of `addonId` held at once by any current or future
 * reservation (non-cancelled, not yet ended). Used to refuse lowering stock
 * below what is already committed. The peak of an interval set is always
 * reached at some interval's start, so each start (clamped to now) is probed.
 */
export async function peakReservedAddonUnits(tx: Db, tenantId: string, addonId: string): Promise<number> {
  const rows = await tx.execute<{ peak: string }>(sql`
    with live as (
      select ba.quantity, ba.starts_at, ba.ends_at
        from booking_addons ba
        join bookings b on b.id = ba.booking_id
       where ba.tenant_id = ${tenantId}
         and ba.addon_id = ${addonId}
         and b.status not in (${sql.join(
           STOCK_RELEASING_STATUSES.map((s) => sql`${s}`),
           sql`, `,
         )})
         and (ba.ends_at is null or ba.ends_at > now())
    ), probes as (
      select greatest(starts_at, now()) as t from live
    )
    select coalesce(max(held), 0)::int as peak
      from (
        select p.t, sum(l.quantity) as held
          from probes p
          join live l on l.starts_at <= p.t and (l.ends_at is null or l.ends_at > p.t)
         group by p.t
      ) x
  `)
  return Number(rows.rows[0]?.peak ?? 0)
}

type CatalogRow = typeof resourceTypeAddons.$inferSelect

/**
 * Step 1 of the stock discipline (see the banner above): lock the referenced
 * catalog rows FOR UPDATE in a fixed (id) order, independent of the order the
 * caller asked for them in. Returns the locked rows keyed by id.
 */
export async function lockAddonCatalog(tx: Db, tenantId: string, ids: string[]): Promise<Map<string, CatalogRow>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .select()
    .from(resourceTypeAddons)
    .where(and(eq(resourceTypeAddons.tenantId, tenantId), inArray(resourceTypeAddons.id, ids)))
    .orderBy(asc(resourceTypeAddons.id))
    .for('update')
  return new Map(rows.map((r) => [r.id, r]))
}

function assertAttachable(row: CatalogRow | undefined, slot: AddonSlotTarget, branchId: string): CatalogRow {
  if (!row || !row.isActive || row.branchId !== branchId || row.resourceTypeId !== slot.resourceTypeId) {
    throw new BookingError('An add-on you selected is no longer available for this resource.')
  }
  return row
}

/**
 * Step 2 of the stock discipline: units still free (stock minus the overlapping
 * reservations) for a catalog row over the window. Only meaningful for a commit
 * decision when `row` came from lockAddonCatalog in this same transaction.
 * May be negative if the owner has since lowered stock below what is booked.
 */
export async function addonHeadroom(
  tx: Db,
  tenantId: string,
  row: CatalogRow,
  startsAt: Date,
  endsAt: Date | null,
  excludeBookingSlotId?: string,
): Promise<number> {
  const reserved = await reservedAddonUnits(tx, tenantId, row.id, startsAt, endsAt, excludeBookingSlotId)
  return row.stockQuantity - reserved
}

/** Refuse (BookingError) if `wanted` units don't fit — call after locking. */
export async function assertStock(
  tx: Db,
  tenantId: string,
  row: CatalogRow,
  wanted: number,
  startsAt: Date,
  endsAt: Date | null,
  excludeBookingSlotId?: string,
): Promise<void> {
  const free = await addonHeadroom(tx, tenantId, row, startsAt, endsAt, excludeBookingSlotId)
  if (wanted > free) {
    throw new BookingError(
      free <= 0
        ? `${row.name} is out of stock for that time.`
        : `Only ${free} × ${row.name} left for that time.`,
    )
  }
}

/**
 * Attach add-ons to freshly created slots. Validates every request against
 * the catalog (active, same branch, same resource type), locks the catalog
 * rows in id order, checks pooled stock, then inserts one booking_addons row
 * per (slot, add-on).
 *
 * `priceNow` true  -> line_total is computed from the slot window (reserved /
 *                     studio bookings — their one pricing pass is creation).
 * `priceNow` false -> line_total stays 0 (walk-ins — priced at checkout by
 *                     priceWalkinAddons).
 *
 * Returns the sum of the line totals written (0 when nothing priced).
 */
export async function attachAddonsToSlots(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  booking: { bookingId: string; branchId: string },
  slots: AddonSlotTarget[],
  opts: { priceNow: boolean },
): Promise<number> {
  const normalized = slots.map((s) => ({ ...s, addons: normalizeAddonRequests(s.addons) }))
  const ids = [...new Set(normalized.flatMap((s) => s.addons.map((a) => a.addonId)))]
  if (ids.length === 0) return 0

  const catalog = await lockAddonCatalog(tx, ctx.tenantId, ids)

  let total = 0
  for (const slot of normalized) {
    for (const req of slot.addons) {
      const row = assertAttachable(catalog.get(req.addonId), slot, booking.branchId)
      // Sequential: rows inserted for an earlier slot in THIS transaction are
      // visible to the next check, so two slots of one booking asking for the
      // same add-on are summed against stock, not checked independently.
      await assertStock(tx, ctx.tenantId, row, req.quantity, slot.startsAt, slot.endsAt)

      const rate = Number(row.rate)
      const lineTotal =
        opts.priceNow && slot.endsAt
          ? addonLineTotal(row.rateUnit, rate, req.quantity, slot.startsAt, slot.endsAt)
          : 0
      total += lineTotal
      await tx.insert(bookingAddons).values({
        tenantId: ctx.tenantId,
        branchId: booking.branchId,
        bookingId: booking.bookingId,
        bookingSlotId: slot.slotId,
        addonId: row.id,
        addonName: row.name,
        rateUnit: row.rateUnit,
        rateApplied: rate.toFixed(2),
        quantity: req.quantity,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        lineTotal: lineTotal.toFixed(2),
        createdBy: ctx.membershipId,
      })
    }
  }
  return round2(total)
}

/**
 * Keep a slot's add-on rows' window in lockstep with booking_slots.ends_at.
 * Called at EVERY site that writes booking_slots.ends_at (extend, end-time
 * correction, checkout, reopen) — otherwise stock availability silently drifts
 * (leaks after checkout, or frees early while a session is still running).
 *
 * Deliberately does NOT touch line_total: extend/correct don't trigger an
 * add-on repricing event (they don't reprice the room either — they just move
 * the end the one later pricing pass reads).
 */
export async function syncSlotAddonEnds(
  tx: Db,
  tenantId: string,
  slotId: string,
  endsAt: Date | null,
  /** Re-check stock for the (possibly longer) window — pass true wherever the
   *  window can GROW (extend, correct, reopen), so moving an end later can't
   *  silently oversell units another booking holds right after this one. */
  opts: { checkStock: boolean } = { checkStock: false },
): Promise<void> {
  const rows = await tx
    .select({
      id: bookingAddons.id,
      addonId: bookingAddons.addonId,
      quantity: bookingAddons.quantity,
      startsAt: bookingAddons.startsAt,
    })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingSlotId, slotId)))
    .orderBy(asc(bookingAddons.addonId))
  if (rows.length === 0) return

  if (opts.checkStock) {
    const ids = [...new Set(rows.map((r) => r.addonId).filter((id): id is string => id !== null))]
    const catalog = await lockAddonCatalog(tx, tenantId, ids)
    for (const r of rows) {
      const row = r.addonId ? catalog.get(r.addonId) : undefined
      if (!row) continue
      await assertStock(tx, tenantId, row, r.quantity, r.startsAt, endsAt, slotId)
    }
  }

  await tx
    .update(bookingAddons)
    .set({ endsAt })
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingSlotId, slotId)))
}

/**
 * Walk-in checkout pricing: compute every add-on line on the booking's slot
 * from [slot start, priceEnd) and stamp ends_at (open tab) alongside.
 * Returns the sum written. No-op (0) when the walk-in has no add-ons.
 */
export async function priceWalkinAddons(
  tx: Db,
  tenantId: string,
  slotId: string,
  startsAt: Date,
  priceEnd: Date,
): Promise<number> {
  const rows = await tx
    .select({
      id: bookingAddons.id,
      rateUnit: bookingAddons.rateUnit,
      rateApplied: bookingAddons.rateApplied,
      quantity: bookingAddons.quantity,
    })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingSlotId, slotId)))
    .orderBy(asc(bookingAddons.id))
  let total = 0
  for (const r of rows) {
    const lineTotal = addonLineTotal(r.rateUnit, Number(r.rateApplied), r.quantity, startsAt, priceEnd)
    total += lineTotal
    await tx
      .update(bookingAddons)
      .set({ lineTotal: lineTotal.toFixed(2), endsAt: priceEnd })
      .where(eq(bookingAddons.id, r.id))
  }
  return round2(total)
}

/**
 * What priceWalkinAddons WOULD charge, writing nothing — for the checkout
 * dialog's live total. The real checkout re-prices from scratch.
 */
export async function previewWalkinAddons(
  tx: Db,
  tenantId: string,
  slotId: string,
  startsAt: Date,
  priceEnd: Date,
): Promise<number> {
  const rows = await tx
    .select({
      rateUnit: bookingAddons.rateUnit,
      rateApplied: bookingAddons.rateApplied,
      quantity: bookingAddons.quantity,
    })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingSlotId, slotId)))
  return round2(
    rows.reduce((sum, r) => sum + addonLineTotal(r.rateUnit, Number(r.rateApplied), r.quantity, startsAt, priceEnd), 0),
  )
}

/** Walk-in reopen: the add-on lines go back to unpriced, like the slot. (The
 *  window is restored separately via syncSlotAddonEnds.) */
export async function unpriceWalkinAddons(tx: Db, tenantId: string, slotId: string): Promise<void> {
  await tx
    .update(bookingAddons)
    .set({ lineTotal: '0.00' })
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingSlotId, slotId)))
}

/** Sum of a booking's add-on line totals (zero when none). */
export async function sumBookingAddons(tx: Db, tenantId: string, bookingId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${bookingAddons.lineTotal}), 0)` })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingId, bookingId)))
  return Number(row?.total ?? 0)
}

// ── post-creation edit tool ──────────────────────────────────────────────────

export type SetSlotAddonsInput = {
  bookingId: string
  bookingSlotId: string
  /** The COMPLETE desired add-on set for this slot — anything not listed is
   *  removed, anything listed with a new quantity is changed. */
  addons: AddonRequest[]
}

/**
 * M33 correction tool: add / remove / change quantity of a slot's add-ons on
 * an UNBILLED booking (same shape as M25's corrections). Locks the booking,
 * refuses a live invoice and a closed/cancelled booking, re-checks stock for
 * every add-on against everyone ELSE, then diffs against the current rows.
 *
 * An existing add-on keeps its frozen snapshot (name/rate/unit) when only its
 * quantity changes — a catalog price edit never reprices it; a newly added one
 * snapshots the catalog as of now.
 *
 * Pricing follows the booking's single pricing pass: a reserved booking (and
 * an already-checked-out walk-in) is repriced right here and bookings.subtotal
 * / total are re-stamped; a walk-in still running is priced at checkout.
 */
export async function setSlotAddonsCore(
  tx: Db,
  ctx: { tenantId: string; membershipId: string | null },
  input: SetSlotAddonsInput,
): Promise<{ bookingId: string; addonTotal: number }> {
  const desired = normalizeAddonRequests(input.addons)

  const [booking] = await tx
    .select({
      id: bookings.id,
      branchId: bookings.branchId,
      status: bookings.status,
      channel: bookings.channel,
      billingMode: bookings.billingMode,
      discount: bookings.discount,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenantId)))
    .for('update')
    .limit(1)
  if (!booking) throw new BookingError('Booking not found.')
  if (booking.status !== 'confirmed' && booking.status !== 'checked_in') {
    throw new BookingError('Add-ons can only be changed on a booking that is still open.')
  }

  if (await findLiveBilling(tx, ctx.tenantId, booking.id)) {
    throw new BookingError('This booking has already been billed — void the bill before changing add-ons.')
  }

  const [slot] = await tx
    .select({
      id: bookingSlots.id,
      resourceId: bookingSlots.resourceId,
      startsAt: bookingSlots.startsAt,
      endsAt: bookingSlots.endsAt,
      slotTotal: bookingSlots.slotTotal,
    })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.id, input.bookingSlotId),
        eq(bookingSlots.bookingId, booking.id),
        eq(bookingSlots.tenantId, ctx.tenantId),
        eq(bookingSlots.active, true),
      ),
    )
    .for('update')
    .limit(1)
  if (!slot) throw new BookingError('That booking slot was not found.')

  const [typeRow] = await tx
    .select({ resourceTypeId: resources.resourceTypeId })
    .from(resources)
    .where(and(eq(resources.id, slot.resourceId), eq(resources.tenantId, ctx.tenantId)))
    .limit(1)
  if (!typeRow) throw new BookingError('Resource not found.')
  const target: AddonSlotTarget = {
    slotId: slot.id,
    resourceTypeId: typeRow.resourceTypeId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    addons: desired,
  }

  const existing = await tx
    .select()
    .from(bookingAddons)
    .where(and(eq(bookingAddons.tenantId, ctx.tenantId), eq(bookingAddons.bookingSlotId, slot.id)))
    .orderBy(asc(bookingAddons.id))
  const existingByAddon = new Map(existing.filter((e) => e.addonId).map((e) => [e.addonId as string, e]))

  // Whether this booking has already had its one pricing pass.
  const isWalkin = booking.channel === 'walkin'
  const priced = !isWalkin
    ? true
    : booking.billingMode === 'timed'
      ? Number(slot.slotTotal) > 0
      : slot.endsAt !== null
  const pricingEnd = slot.endsAt

  const catalog = await lockAddonCatalog(tx, ctx.tenantId, desired.map((d) => d.addonId))

  // What this edit actually changed — the audit entry's body.
  const changes: (
    | { change: 'added'; addon: string; quantity: number }
    | { change: 'removed'; addon: string; quantity: number }
    | { change: 'quantity'; addon: string; from: number; to: number }
  )[] = []

  // Removals first (frees stock for a swap within this edit). A row whose
  // catalog entry was since deleted (addon_id null) has no id the caller can
  // list, so it is NOT "absent from desired" — it is left alone: it is booking
  // history the editor shows read-only, never something an edit may drop.
  const desiredIds = new Set(desired.map((d) => d.addonId))
  for (const e of existing) {
    if (e.addonId !== null && !desiredIds.has(e.addonId)) {
      await tx.delete(bookingAddons).where(eq(bookingAddons.id, e.id))
      changes.push({ change: 'removed', addon: e.addonName, quantity: e.quantity })
    }
  }

  for (const req of desired) {
    const prior = existingByAddon.get(req.addonId)
    const row = catalog.get(req.addonId)
    if (prior) {
      // Unchanged quantity: nothing to check or write. A changed quantity
      // re-checks stock; the catalog row may since have been deactivated, which
      // must not block REMOVING or REDUCING an add-on already on the booking.
      if (prior.quantity === req.quantity) continue
      if (req.quantity > prior.quantity) {
        if (!row) throw new BookingError('An add-on you selected is no longer available for this resource.')
        await assertStock(tx, ctx.tenantId, row, req.quantity, target.startsAt, target.endsAt, slot.id)
      }
      const lineTotal =
        priced && pricingEnd
          ? addonLineTotal(prior.rateUnit, Number(prior.rateApplied), req.quantity, prior.startsAt, pricingEnd)
          : 0
      await tx
        .update(bookingAddons)
        .set({ quantity: req.quantity, lineTotal: lineTotal.toFixed(2) })
        .where(eq(bookingAddons.id, prior.id))
      changes.push({ change: 'quantity', addon: prior.addonName, from: prior.quantity, to: req.quantity })
      continue
    }

    const valid = assertAttachable(row, target, booking.branchId)
    await assertStock(tx, ctx.tenantId, valid, req.quantity, target.startsAt, target.endsAt, slot.id)
    const rate = Number(valid.rate)
    const lineTotal =
      priced && pricingEnd ? addonLineTotal(valid.rateUnit, rate, req.quantity, slot.startsAt, pricingEnd) : 0
    await tx.insert(bookingAddons).values({
      tenantId: ctx.tenantId,
      branchId: booking.branchId,
      bookingId: booking.id,
      bookingSlotId: slot.id,
      addonId: valid.id,
      addonName: valid.name,
      rateUnit: valid.rateUnit,
      rateApplied: rate.toFixed(2),
      quantity: req.quantity,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      lineTotal: lineTotal.toFixed(2),
      createdBy: ctx.membershipId,
    })
    changes.push({ change: 'added', addon: valid.name, quantity: req.quantity })
  }

  const addonTotal = await sumBookingAddons(tx, ctx.tenantId, booking.id)

  // Re-stamp the booking's own totals when it has been priced (reserved, or a
  // checked-out walk-in): subtotal = active slot totals + add-ons.
  if (priced) {
    const [slotSum] = await tx
      .select({ total: sql<string>`coalesce(sum(${bookingSlots.slotTotal}), 0)` })
      .from(bookingSlots)
      .where(
        and(eq(bookingSlots.tenantId, ctx.tenantId), eq(bookingSlots.bookingId, booking.id), eq(bookingSlots.active, true)),
      )
    const subtotal = round2(Number(slotSum?.total ?? 0) + addonTotal)
    const total = Math.max(0, round2(subtotal - Number(booking.discount)))
    await tx
      .update(bookings)
      .set({ subtotal: subtotal.toFixed(2), total: total.toFixed(2) })
      .where(and(eq(bookings.id, booking.id), eq(bookings.tenantId, ctx.tenantId)))
  }

  // A correction tool, so it is audited (an edit that changed nothing is not).
  if (changes.length > 0) {
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      actorMembershipId: ctx.membershipId,
      action: 'booking.addon_edited',
      entityType: 'booking',
      entityId: booking.id,
      before: { addons: existing.map((e) => ({ name: e.addonName, quantity: e.quantity })) },
      after: { slotId: slot.id, changes, addonTotal: addonTotal.toFixed(2) },
    })
  }

  return { bookingId: booking.id, addonTotal }
}

// ── availability listing (pickers) ───────────────────────────────────────────

export type AvailableAddon = {
  id: string
  resourceTypeId: string
  name: string
  rateUnit: AddonRateUnit
  rate: string
  stockQuantity: number
  /** Units still free over the requested window (never below 0). */
  available: number
}

/**
 * Active add-ons for the given resource types at one branch, each with how many
 * units are still free over [startsAt, endsAt) — what the booking / walk-in
 * pickers render. Read-only and unlocked: the real attach re-checks under the
 * catalog lock, so a stale picker can only ever be refused, never oversell.
 * `endsAt` null = an open tab (unbounded window). `excludeBookingSlotId`
 * leaves one slot's own reservations out (the edit tool).
 */
export async function listAvailableAddons(
  tx: Db,
  tenantId: string,
  input: {
    branchId: string
    resourceTypeIds: string[]
    startsAt: Date
    endsAt: Date | null
    excludeBookingSlotId?: string
  },
): Promise<AvailableAddon[]> {
  if (input.resourceTypeIds.length === 0) return []
  const rows = await tx
    .select()
    .from(resourceTypeAddons)
    .where(
      and(
        eq(resourceTypeAddons.tenantId, tenantId),
        eq(resourceTypeAddons.branchId, input.branchId),
        eq(resourceTypeAddons.isActive, true),
        inArray(resourceTypeAddons.resourceTypeId, input.resourceTypeIds),
      ),
    )
    .orderBy(asc(resourceTypeAddons.sortOrder), asc(resourceTypeAddons.name))
  const out: AvailableAddon[] = []
  for (const r of rows) {
    const reserved = await reservedAddonUnits(
      tx,
      tenantId,
      r.id,
      input.startsAt,
      input.endsAt,
      input.excludeBookingSlotId,
    )
    out.push({
      id: r.id,
      resourceTypeId: r.resourceTypeId,
      name: r.name,
      rateUnit: r.rateUnit,
      rate: r.rate,
      stockQuantity: r.stockQuantity,
      available: Math.max(0, r.stockQuantity - reserved),
    })
  }
  return out
}

/** A booking's current add-on rows, for the edit tool. */
export async function listBookingAddons(tx: Db, tenantId: string, bookingId: string) {
  return tx
    .select({
      id: bookingAddons.id,
      bookingSlotId: bookingAddons.bookingSlotId,
      addonId: bookingAddons.addonId,
      name: bookingAddons.addonName,
      rateUnit: bookingAddons.rateUnit,
      rateApplied: bookingAddons.rateApplied,
      quantity: bookingAddons.quantity,
      lineTotal: bookingAddons.lineTotal,
    })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.tenantId, tenantId), eq(bookingAddons.bookingId, bookingId)))
    .orderBy(asc(bookingAddons.createdAt), asc(bookingAddons.id))
}
