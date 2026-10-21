/**
 * The print-job queue, producer side (M19 / AROS-175). Takes a `tx`, no
 * 'server-only', same pattern as lib/kots/*.ts, so order creation and billing
 * can enqueue INSIDE their own transaction (a ticket exists iff the order does)
 * and the standalone test scripts can import it.
 *
 * Opt-in is implicit: a branch with no active printer of the needed kind makes
 * every function here a cheap no-op (one indexed query) and the existing
 * browser web-print remains the only path. Nothing here ever throws because a
 * printer is missing; a job that can't be delivered shows up as failed/stale
 * in the queue (lib/printing/queue.ts) instead of vanishing.
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import {
  bookings,
  branches,
  kitchenStations,
  kots,
  orderItemModifiers,
  orderItems,
  orders,
  printJobs,
  printers,
  resources,
  tenants,
} from '@/db/schema'
import { renderKitchenTicket, renderReceipt, type ReceiptData, type TicketLine } from './render'

type Db = NodePgDatabase<typeof schema>
type Printer = typeof printers.$inferSelect

function timeIn(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
}

export function dateTimeIn(tz: string, d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

async function activePrinters(tx: Db, tenantId: string, branchId: string, kind: 'kitchen' | 'receipt'): Promise<Printer[]> {
  return tx
    .select()
    .from(printers)
    .where(and(eq(printers.tenantId, tenantId), eq(printers.branchId, branchId), eq(printers.kind, kind), eq(printers.isActive, true)))
    .orderBy(desc(printers.isDefault), asc(printers.createdAt))
}

async function insertJob(
  tx: Db,
  v: {
    tenantId: string
    branchId: string
    printer: Printer
    kind: 'kitchen_ticket' | 'receipt' | 'test'
    title: string
    payload: Buffer
    kotId?: string
    invoiceId?: string
    createdBy?: string | null
  },
): Promise<string> {
  const [row] = await tx
    .insert(printJobs)
    .values({
      tenantId: v.tenantId,
      branchId: v.branchId,
      printerId: v.printer.id,
      kind: v.kind,
      title: v.title,
      payload: v.payload,
      kotId: v.kotId ?? null,
      invoiceId: v.invoiceId ?? null,
      createdBy: v.createdBy ?? null,
    })
    .returning({ id: printJobs.id })
  return row.id
}

/**
 * Print the kitchen ticket(s) for an order: its fired, not-voided lines (or just
 * `lineIds`, for a fired course), split by the printer their station maps to —
 * one paper per printer. A line whose station has no printer (or no station at
 * all) goes to the branch's default kitchen printer. Returns jobs created.
 */
export async function enqueueKitchenTicketsCore(
  tx: Db,
  a: {
    tenantId: string
    branchId: string
    orderId: string
    reason: 'new' | 'fire' | 'reprint'
    lineIds?: string[]
    membershipId?: string | null
  },
): Promise<number> {
  const kitchenPrinters = await activePrinters(tx, a.tenantId, a.branchId, 'kitchen')
  if (kitchenPrinters.length === 0) return 0

  const [head] = await tx
    .select({
      kotId: kots.id,
      kotNumber: kots.kotNumber,
      orderNumber: orders.orderNumber,
      channel: orders.channel,
      tableName: resources.name,
      tz: tenants.timezone,
    })
    .from(kots)
    .innerJoin(orders, eq(orders.id, kots.orderId))
    .innerJoin(tenants, eq(tenants.id, orders.tenantId))
    .leftJoin(resources, eq(resources.id, orders.resourceId))
    .where(and(eq(kots.orderId, a.orderId), eq(kots.tenantId, a.tenantId), ne(kots.status, 'cancelled')))
    .limit(1)
  if (!head) return 0

  const lines = await tx
    .select({
      id: orderItems.id,
      qty: orderItems.qty,
      name: orderItems.itemName,
      notes: orderItems.specialInstructions,
      courseName: orderItems.courseName,
      stationId: orderItems.stationId,
      stationName: orderItems.stationName,
    })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, a.orderId),
        eq(orderItems.tenantId, a.tenantId),
        eq(orderItems.fireStatus, 'fired'),
        ne(orderItems.voidStatus, 'voided'),
        a.lineIds ? inArray(orderItems.id, a.lineIds) : undefined,
      ),
    )
    .orderBy(asc(orderItems.courseNo), asc(orderItems.id))
  if (lines.length === 0) return 0

  const mods = await tx
    .select({ orderItemId: orderItemModifiers.orderItemId, name: orderItemModifiers.optionName })
    .from(orderItemModifiers)
    .where(and(eq(orderItemModifiers.tenantId, a.tenantId), inArray(orderItemModifiers.orderItemId, lines.map((l) => l.id))))
  const modsByLine = new Map<string, string[]>()
  for (const m of mods) modsByLine.set(m.orderItemId, [...(modsByLine.get(m.orderItemId) ?? []), m.name])

  // station → printer, only for stations that still exist and whose printer is live.
  const stationIds = [...new Set(lines.map((l) => l.stationId).filter((s): s is string => !!s))]
  const stationPrinter = new Map<string, string>()
  if (stationIds.length > 0) {
    const rows = await tx
      .select({ id: kitchenStations.id, printerId: kitchenStations.printerId })
      .from(kitchenStations)
      .where(and(eq(kitchenStations.tenantId, a.tenantId), inArray(kitchenStations.id, stationIds)))
    for (const r of rows) if (r.printerId) stationPrinter.set(r.id, r.printerId)
  }
  const byId = new Map(kitchenPrinters.map((p) => [p.id, p]))
  const fallback = kitchenPrinters[0] // default first (see activePrinters ordering)

  const perPrinter = new Map<string, { printer: Printer; stationName: string | null; lines: TicketLine[] }>()
  for (const l of lines) {
    const mapped = l.stationId ? byId.get(stationPrinter.get(l.stationId) ?? '') : undefined
    const printer = mapped ?? fallback
    const bucket = perPrinter.get(printer.id) ?? { printer, stationName: mapped ? l.stationName : null, lines: [] }
    perPrinter.set(printer.id, bucket)
    bucket.lines.push({
      qty: l.qty,
      name: l.name,
      modifiers: modsByLine.get(l.id) ?? [],
      notes: l.notes,
      courseName: l.courseName,
    })
  }

  let created = 0
  for (const b of perPrinter.values()) {
    const payload = renderKitchenTicket(
      {
        kotNumber: head.kotNumber,
        orderNumber: head.orderNumber,
        tableName: head.tableName,
        stationName: b.stationName,
        channel: head.channel,
        time: timeIn(head.tz),
        reason: a.reason,
        lines: b.lines,
      },
      b.printer.paperChars,
    )
    await insertJob(tx, {
      tenantId: a.tenantId,
      branchId: a.branchId,
      printer: b.printer,
      kind: 'kitchen_ticket',
      title: `${head.kotNumber}${b.stationName ? ` · ${b.stationName}` : ''}${a.reason === 'fire' ? ' · fire' : ''}`,
      payload,
      kotId: head.kotId,
      createdBy: a.membershipId,
    })
    created++
  }
  return created
}

/** Kitchen ticket by KOT id (for "reprint" and the accept-online-order hook). */
export async function enqueueKitchenTicketsForOrderCore(
  tx: Db,
  tenantId: string,
  orderId: string,
  reason: 'new' | 'fire' | 'reprint',
  membershipId?: string | null,
  lineIds?: string[],
) {
  const [o] = await tx
    .select({ branchId: orders.branchId })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)
  if (!o) return 0
  return enqueueKitchenTicketsCore(tx, { tenantId, branchId: o.branchId, orderId, reason, membershipId, lineIds })
}

/** The branch a bill belongs to: its booking's, else the tenant's primary. */
async function branchForBill(tx: Db, tenantId: string, bookingId: string | null): Promise<string | null> {
  if (bookingId) {
    const [b] = await tx
      .select({ branchId: bookings.branchId })
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
      .limit(1)
    if (b) return b.branchId
  }
  const [p] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true)))
    .limit(1)
  return p?.id ?? null
}

/** Queue a bill/receipt on the branch's receipt printer. 'no_printer' = none configured. */
export async function enqueueReceiptCore(
  tx: Db,
  a: { tenantId: string; invoiceId: string; bookingId: string | null; data: ReceiptData; membershipId?: string | null },
): Promise<'queued' | 'no_printer'> {
  const branchId = await branchForBill(tx, a.tenantId, a.bookingId)
  if (!branchId) return 'no_printer'
  const [printer] = await activePrinters(tx, a.tenantId, branchId, 'receipt')
  if (!printer) return 'no_printer'
  await insertJob(tx, {
    tenantId: a.tenantId,
    branchId,
    printer,
    kind: 'receipt',
    title: `${a.data.isBill ? 'Bill' : 'Receipt'} ${a.data.invoiceNumber}`,
    payload: renderReceipt(a.data, printer.paperChars),
    invoiceId: a.invoiceId,
    createdBy: a.membershipId,
  })
  return 'queued'
}

/** A short self-identifying slip — proves the printer, URL and media type work. */
export async function enqueueTestPrintCore(tx: Db, tenantId: string, printerId: string, membershipId?: string | null): Promise<void> {
  const [printer] = await tx
    .select()
    .from(printers)
    .where(and(eq(printers.id, printerId), eq(printers.tenantId, tenantId)))
    .limit(1)
  if (!printer) throw new Error('Printer not found.')
  const payload = renderKitchenTicket(
    {
      kotNumber: 'TEST PRINT',
      orderNumber: printer.name,
      tableName: null,
      stationName: null,
      channel: 'staff',
      time: timeIn('Asia/Kolkata'),
      reason: 'new',
      lines: [{ qty: 1, name: 'Printer is working', modifiers: ['Arena OS cloud print'], notes: null, courseName: null }],
    },
    printer.paperChars,
  )
  await insertJob(tx, {
    tenantId,
    branchId: printer.branchId,
    printer,
    kind: 'test',
    title: `Test print · ${printer.name}`,
    payload,
    createdBy: membershipId,
  })
}
