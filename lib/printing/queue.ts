import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { printJobs, printers } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** A job still 'sent' this long after it was handed over was never confirmed. */
export const UNCONFIRMED_AFTER_MS = 2 * 60_000
/** A job still 'pending' this long means the printer isn't picking it up. */
export const STUCK_AFTER_MS = 2 * 60_000
/** A printer that hasn't polled for this long is offline (CloudPRNT polls every few seconds). */
export const OFFLINE_AFTER_MS = 2 * 60_000

export type JobProblem = 'failed' | 'unconfirmed' | 'stuck'

export type PrintJobRow = {
  id: string
  printerId: string
  printerName: string
  kind: 'kitchen_ticket' | 'receipt' | 'test'
  title: string
  status: 'pending' | 'sent' | 'printed' | 'failed' | 'cancelled'
  error: string | null
  createdAt: Date
  kotId: string | null
  invoiceId: string | null
  /** Set when this job needs staff attention — never silently dropped. */
  problem: JobProblem | null
}

export function jobProblem(
  j: { status: PrintJobRow['status']; createdAt: Date; sentAt: Date | null },
  now = Date.now(),
): JobProblem | null {
  if (j.status === 'failed') return 'failed'
  if (j.status === 'sent' && j.sentAt && now - j.sentAt.getTime() > UNCONFIRMED_AFTER_MS) return 'unconfirmed'
  if (j.status === 'pending' && now - j.createdAt.getTime() > STUCK_AFTER_MS) return 'stuck'
  return null
}

/** Recent jobs (last 24h) plus anything still unresolved, newest first. */
export function listPrintJobs(ctx: ActiveContext, limit = 100): Promise<PrintJobRow[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: printJobs.id,
        printerId: printJobs.printerId,
        printerName: printers.name,
        kind: printJobs.kind,
        title: printJobs.title,
        status: printJobs.status,
        error: printJobs.error,
        createdAt: printJobs.createdAt,
        sentAt: printJobs.sentAt,
        kotId: printJobs.kotId,
        invoiceId: printJobs.invoiceId,
      })
      .from(printJobs)
      .innerJoin(printers, eq(printers.id, printJobs.printerId))
      .where(
        and(
          eq(printJobs.tenantId, ctx.tenant.id),
          sql`(${printJobs.createdAt} > now() - interval '24 hours' or ${printJobs.status} in ('pending','sent','failed'))`,
        ),
      )
      .orderBy(desc(printJobs.createdAt))
      .limit(limit)
    return rows.map(({ sentAt, ...r }) => ({ ...r, problem: jobProblem({ status: r.status, createdAt: r.createdAt, sentAt }) }))
  })
}

export type PrintAlert = { failed: number; unconfirmed: number; stuck: number; offlinePrinters: string[] }

/**
 * What the kitchen screen's banner shows: jobs that need attention and printers
 * that stopped polling. Null for a tenant with no printers (no banner, no cost
 * beyond one query).
 */
export function getPrintAlert(ctx: ActiveContext): Promise<PrintAlert | null> {
  return withUser(ctx.user.id, async (tx) => {
    const ps = await tx
      .select({ name: printers.name, lastSeenAt: printers.lastSeenAt })
      .from(printers)
      .where(and(eq(printers.tenantId, ctx.tenant.id), eq(printers.isActive, true)))
    if (ps.length === 0) return null
    const now = Date.now()
    const open = await tx
      .select({ status: printJobs.status, createdAt: printJobs.createdAt, sentAt: printJobs.sentAt })
      .from(printJobs)
      .where(and(eq(printJobs.tenantId, ctx.tenant.id), inArray(printJobs.status, ['pending', 'sent', 'failed'])))
    const alert: PrintAlert = { failed: 0, unconfirmed: 0, stuck: 0, offlinePrinters: [] }
    for (const j of open) {
      const p = jobProblem(j, now)
      if (p) alert[p] += 1
    }
    for (const p of ps) {
      if (!p.lastSeenAt || now - p.lastSeenAt.getTime() > OFFLINE_AFTER_MS) alert.offlinePrinters.push(p.name)
    }
    return alert
  })
}

