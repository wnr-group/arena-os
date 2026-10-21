import { NextResponse, type NextRequest } from 'next/server'
import { ackJob, fetchJob, pollPrinter } from '@/lib/printing/cloudprnt'

/**
 * Star CloudPRNT endpoint (M19 / AROS-175) — the URL a venue's printer is
 * configured with. Machine-to-machine: no session cookie (the proxy lets
 * /api/cloudprnt/ through); the printer id + secret in the path are the
 * credential and are re-verified in SQL on every call. Any unknown/revoked
 * credential gets the same bare 404 so the URL space leaks nothing.
 */
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET = /^[A-Za-z0-9_-]{16,128}$/

type Ctx = { params: Promise<{ printerId: string; secret: string }> }

async function creds(ctx: Ctx) {
  const { printerId, secret } = await ctx.params
  return UUID.test(printerId) && SECRET.test(secret) ? { printerId, secret } : null
}

const notFound = () => new NextResponse(null, { status: 404 })

/** Poll. The printer reports its status; we say whether a job is waiting. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const c = await creds(ctx)
  if (!c) return notFound()
  let body: { printerMAC?: unknown; statusCode?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    // A poll with no/invalid JSON still counts as liveness.
  }
  const mac = typeof body.printerMAC === 'string' ? body.printerMAC.slice(0, 32) : ''
  const status = typeof body.statusCode === 'string' ? body.statusCode : ''
  const r = await pollPrinter(c.printerId, c.secret, mac, status)
  if (!r.ok) return notFound()
  if (!r.jobId) return NextResponse.json({ jobReady: false })
  return NextResponse.json({ jobReady: true, mediaTypes: [r.mediaType], jobToken: r.jobId, deleteMethod: 'DELETE' })
}

/** Fetch the job's bytes. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const c = await creds(ctx)
  if (!c) return notFound()
  const q = req.nextUrl.searchParams
  let token = q.get('token')
  if (!token) {
    // Older firmware may not echo the job token; ask the poll function again.
    const r = await pollPrinter(c.printerId, c.secret, q.get('mac') ?? '', '')
    token = r.ok ? r.jobId : null
  }
  if (!token || !UUID.test(token)) return notFound()
  const bytes = await fetchJob(c.printerId, c.secret, token)
  if (!bytes) return notFound()
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': q.get('type') || 'application/vnd.star.starprnt',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    },
  })
}

/** Confirm. `code=OK` (or 2xx) = printed; anything else is recorded as a failure. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const c = await creds(ctx)
  if (!c) return notFound()
  const q = req.nextUrl.searchParams
  let token = q.get('token')
  if (!token) {
    const r = await pollPrinter(c.printerId, c.secret, q.get('mac') ?? '', '')
    token = r.ok ? r.jobId : null
  }
  if (!token || !UUID.test(token)) return new NextResponse(null, { status: 200 })
  await ackJob(c.printerId, c.secret, token, q.get('code') ?? '')
  return new NextResponse(null, { status: 200 })
}
