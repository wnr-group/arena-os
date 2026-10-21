import 'server-only'
import { sql } from 'drizzle-orm'
import { withPublicApp } from '@/db'

/**
 * Star CloudPRNT device protocol, server side (M19 / AROS-175).
 *
 * The printer calls ONE url (printer id + secret in the path) with three verbs:
 *   POST   poll — "anything for me?"  → { jobReady, mediaTypes, jobToken }
 *   GET    fetch the job's bytes      (?token=<jobToken>&type=<media type>&mac=…)
 *   DELETE confirm the outcome        (?token=…&code=OK | an error string)
 * Everything goes through the SECURITY DEFINER cloudprnt_* functions
 * (migration 0149), each of which re-verifies the secret — this module holds no
 * business logic and never touches the tables directly.
 */

export type PollResult =
  | { ok: false }
  | { ok: true; jobId: string | null; mediaType: string }

export function pollPrinter(printerId: string, secret: string, mac: string, status: string): Promise<PollResult> {
  return withPublicApp(async (tx) => {
    const r = await tx.execute(
      sql`select ok, job_id, media_type from public.cloudprnt_poll(${printerId}::uuid, ${secret}, ${mac}, ${status})`,
    )
    const row = r.rows[0] as { ok: boolean; job_id: string | null; media_type: string } | undefined
    if (!row || !row.ok) return { ok: false as const }
    return { ok: true as const, jobId: row.job_id, mediaType: row.media_type }
  })
}

export function fetchJob(printerId: string, secret: string, jobId: string): Promise<Buffer | null> {
  return withPublicApp(async (tx) => {
    const r = await tx.execute(sql`select public.cloudprnt_fetch(${printerId}::uuid, ${secret}, ${jobId}::uuid) as payload`)
    const v = (r.rows[0] as { payload: Buffer | null } | undefined)?.payload
    return v ?? null
  })
}

export function ackJob(printerId: string, secret: string, jobId: string, code: string): Promise<boolean> {
  return withPublicApp(async (tx) => {
    const r = await tx.execute(sql`select public.cloudprnt_ack(${printerId}::uuid, ${secret}, ${jobId}::uuid, ${code}) as ok`)
    return Boolean((r.rows[0] as { ok: boolean } | undefined)?.ok)
  })
}
