'use server'

import { createHash, randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { branches, kitchenStations, kots, printJobs, printers } from '@/db/schema'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { enqueueKitchenTicketsForOrderCore, enqueueTestPrintCore } from '@/lib/printing/jobs'
import { printInvoice } from '@/lib/printing/auto'

type Result = { error?: string }
const MODULE = 'module.printing'

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof EntitlementError) return { error: e.message }
  const code = (e as { cause?: { code?: string } }).cause?.code
  if (code === '23505') return { error: 'A printer with that name already exists.' }
  console.error('[printing] action failed:', e)
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** Setup is a manager/owner job on a plan that includes printing. */
async function guardSetup() {
  const ctx = await requireManager()
  await requireEntitlement(ctx, MODULE)
  return ctx
}

const hash = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex')
const newSecret = () => randomBytes(24).toString('base64url')

function done(): Result {
  revalidatePath('/kitchen')
  revalidatePath('/kitchen/printers')
  return {}
}

const printerInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(40),
  kind: z.enum(['kitchen', 'receipt']),
  paperChars: z.coerce.number().int().min(24).max(64).default(42),
  mediaType: z.string().trim().min(3).max(100).default('application/vnd.star.starprnt'),
})

/**
 * Register a printer. Returns the device URL path and its secret EXACTLY ONCE
 * (only a hash is stored) — enter `<origin><path>` as the Server URL in the
 * printer's CloudPRNT settings.
 */
export async function createPrinter(input: z.input<typeof printerInput>): Promise<Result & { path?: string }> {
  try {
    const ctx = await guardSetup()
    const v = printerInput.parse(input)
    const secret = newSecret()
    const id = await withUser(ctx.user.id, async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
        .limit(1)
      if (!branch) throw new AuthError('No branch configured.')
      const existing = await tx
        .select({ id: printers.id })
        .from(printers)
        .where(and(eq(printers.tenantId, ctx.tenant.id), eq(printers.branchId, branch.id), eq(printers.kind, v.kind)))
        .limit(1)
      const [row] = await tx
        .insert(printers)
        .values({
          tenantId: ctx.tenant.id,
          branchId: branch.id,
          name: v.name,
          kind: v.kind,
          paperChars: v.paperChars,
          mediaType: v.mediaType,
          secretHash: hash(secret),
          // The first of each kind is the default (kitchen: takes unrouted lines).
          isDefault: existing.length === 0,
        })
        .returning({ id: printers.id })
      return row.id
    })
    done()
    return { path: `/api/cloudprnt/${id}/${secret}` }
  } catch (e) {
    return fail(e)
  }
}

/** New secret → the old URL stops working immediately. Shown once. */
export async function rotatePrinterSecret(printerId: string): Promise<Result & { path?: string }> {
  try {
    const ctx = await guardSetup()
    const secret = newSecret()
    await withUser(ctx.user.id, (tx) =>
      tx.update(printers).set({ secretHash: hash(secret) }).where(and(eq(printers.id, printerId), eq(printers.tenantId, ctx.tenant.id))),
    )
    done()
    return { path: `/api/cloudprnt/${printerId}/${secret}` }
  } catch (e) {
    return fail(e)
  }
}

export async function updatePrinter(
  printerId: string,
  v: { name?: string; paperChars?: number; mediaType?: string; isActive?: boolean; isDefault?: boolean },
): Promise<Result> {
  try {
    const ctx = await guardSetup()
    await withUser(ctx.user.id, async (tx) => {
      const [p] = await tx
        .select({ branchId: printers.branchId, kind: printers.kind })
        .from(printers)
        .where(and(eq(printers.id, printerId), eq(printers.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!p) throw new AuthError('Printer not found.')
      const set: Partial<typeof printers.$inferInsert> = {}
      if (v.name !== undefined) set.name = z.string().trim().min(1).max(40).parse(v.name)
      if (v.paperChars !== undefined) set.paperChars = z.number().int().min(24).max(64).parse(v.paperChars)
      if (v.mediaType !== undefined) set.mediaType = z.string().trim().min(3).max(100).parse(v.mediaType)
      if (v.isActive !== undefined) set.isActive = v.isActive
      if (v.isDefault === true) {
        // One default per branch + kind.
        await tx
          .update(printers)
          .set({ isDefault: false })
          .where(
            and(
              eq(printers.tenantId, ctx.tenant.id),
              eq(printers.branchId, p.branchId),
              eq(printers.kind, p.kind),
              ne(printers.id, printerId),
            ),
          )
        set.isDefault = true
      }
      if (Object.keys(set).length > 0) {
        await tx.update(printers).set(set).where(and(eq(printers.id, printerId), eq(printers.tenantId, ctx.tenant.id)))
      }
    })
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function deletePrinter(printerId: string): Promise<Result> {
  try {
    const ctx = await guardSetup()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(printers).where(and(eq(printers.id, printerId), eq(printers.tenantId, ctx.tenant.id))),
    )
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Which kitchen printer a station's tickets go to; null = the default printer. */
export async function assignStationPrinter(stationId: string, printerId: string | null): Promise<Result> {
  try {
    const ctx = await guardSetup()
    await withUser(ctx.user.id, async (tx) => {
      if (printerId) {
        const [p] = await tx
          .select({ id: printers.id })
          .from(printers)
          .where(and(eq(printers.id, printerId), eq(printers.tenantId, ctx.tenant.id), eq(printers.kind, 'kitchen')))
          .limit(1)
        if (!p) throw new AuthError('Pick one of your kitchen printers.')
      }
      await tx
        .update(kitchenStations)
        .set({ printerId })
        .where(and(eq(kitchenStations.id, stationId), eq(kitchenStations.tenantId, ctx.tenant.id)))
    })
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function sendTestPrint(printerId: string): Promise<Result> {
  try {
    const ctx = await guardSetup()
    await withUser(ctx.user.id, (tx) => enqueueTestPrintCore(tx, ctx.tenant.id, printerId, ctx.membershipId))
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Put a failed / unconfirmed / stuck job back in the queue. */
export async function retryPrintJob(jobId: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    await requireEntitlement(ctx, MODULE)
    const rows = await withUser(ctx.user.id, (tx) =>
      tx
        .update(printJobs)
        .set({ status: 'pending', error: null, sentAt: null, finishedAt: null, attempts: 0 })
        .where(
          and(eq(printJobs.id, jobId), eq(printJobs.tenantId, ctx.tenant.id), inArray(printJobs.status, ['failed', 'sent', 'pending'])),
        )
        .returning({ id: printJobs.id }),
    )
    if (rows.length === 0) throw new AuthError('That job can not be retried (it may already have printed).')
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Give up on a job (e.g. the ticket was written by hand). Clears the alert. */
export async function cancelPrintJob(jobId: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    await requireEntitlement(ctx, MODULE)
    const rows = await withUser(ctx.user.id, (tx) =>
      tx
        .update(printJobs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(
          and(eq(printJobs.id, jobId), eq(printJobs.tenantId, ctx.tenant.id), inArray(printJobs.status, ['failed', 'sent', 'pending'])),
        )
        .returning({ id: printJobs.id }),
    )
    if (rows.length === 0) throw new AuthError('That job can not be cancelled.')
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Invoice page button: send this bill/receipt to the receipt printer. */
export async function printReceipt(invoiceId: string): Promise<Result & { queued?: boolean }> {
  try {
    const ctx = await requireContext()
    await requireEntitlement(ctx, MODULE)
    const r = await printInvoice(ctx, invoiceId)
    if (r === 'no_printer') {
      return { error: 'No receipt printer is set up — use "Print / Save as PDF" instead.' }
    }
    return { queued: true }
  } catch (e) {
    return fail(e)
  }
}

/** Kitchen ticket reprint on the venue's printers (the browser print link remains). */
export async function reprintKitchenTicket(kotId: string): Promise<Result & { queued?: number }> {
  try {
    const ctx = await requireContext()
    await requireEntitlement(ctx, MODULE)
    const n = await withUser(ctx.user.id, async (tx) => {
      const [k] = await tx
        .select({ orderId: kots.orderId })
        .from(kots)
        .where(and(eq(kots.id, kotId), eq(kots.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!k) throw new AuthError('Ticket not found.')
      return enqueueKitchenTicketsForOrderCore(tx, ctx.tenant.id, k.orderId, 'reprint', ctx.membershipId)
    })
    if (n === 0) return { error: 'No kitchen printer is set up — use the browser print link.' }
    revalidatePath('/kitchen/printers')
    return { queued: n }
  } catch (e) {
    return fail(e)
  }
}
