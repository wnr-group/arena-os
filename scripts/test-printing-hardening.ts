/**
 * Printing hardening: encoder bounds (pure) and retention (database).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-printing-hardening.ts
 *
 * The at-most-twice delivery rule is covered in test-printing.ts (cloudprnt_*
 * protocol section); this file covers the rest of the hardening ticket.
 */
import { Pool } from 'pg'
import { EscPos, MAX_FIELD_LINES, MAX_JOB_BYTES, toAscii, wrap } from '../lib/printing/escpos'
import { renderKitchenTicket } from '../lib/printing/render'
import { pruneOldPrintJobs } from '../lib/printing/retention'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, detail?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else {
    fail++
    if (detail !== undefined) console.log('        got:', detail)
  }
}

const base = {
  kotNumber: 'KOT-1',
  orderNumber: 'OR-1',
  tableName: 'T1',
  stationName: null,
  channel: 'staff' as const,
  time: '7:42 PM',
  reason: 'new' as const,
}
const line = (over: Partial<{ name: string; notes: string | null; modifiers: string[] }> = {}) => ({
  qty: 1,
  name: 'Burger',
  modifiers: [] as string[],
  notes: null as string | null,
  courseName: null,
  ...over,
})
const LF = 0x0a
const count = (b: Buffer, byte: number) => b.reduce((n, x) => n + (x === byte ? 1 : 0), 0)

async function main() {
  // ── encoder bounds ────────────────────────────────────────────────────────
  check('blank-line runs collapse to one blank line', toAscii('a\n\n\n\n\nb') === 'a\n\nb')
  check('spaces around newlines are trimmed', toAscii('a  \n   b') === 'a\nb')
  check('ordinary text still transliterates as before', toAscii('₹250 × 2 – Café') === 'Rs 250 x 2 - Cafe')
  check('wrap caps a field at maxLines with an ellipsis', wrap('x\n'.repeat(500), 40, 5).join('|') === 'x|x|x|x|...')
  check('wrap caps the characters it will look at', wrap('a'.repeat(100_000), 40).length <= Math.ceil(1000 / 40))

  const note = renderKitchenTicket({ ...base, lines: [line({ notes: 'x\n'.repeat(5000) })] })
  check('a 5,000-line note prints at most the field cap of lines', count(note, LF) < 80, count(note, LF))
  check('…and the job is small', note.length < 2000, note.length)

  const blanks = renderKitchenTicket({ ...base, lines: [line({ notes: '\n'.repeat(5000) })] })
  check('5,000 blank lines in a note print almost nothing', count(blanks, LF) < 40, count(blanks, LF))

  const huge = renderKitchenTicket({
    ...base,
    lines: Array.from({ length: 3000 }, (_, i) => line({ name: `Item ${i} ${'n'.repeat(480)}`, notes: 'y'.repeat(500) })),
  })
  check('3,000 lines x 500 chars is capped at the job limit', huge.length <= MAX_JOB_BYTES, huge.length)
  const tail = huge.subarray(huge.length - 80).toString('latin1')
  check('a capped job says so and still ends with a cut', /TICKET TRUNCATED/.test(tail) && huge[huge.length - 4] === 0x1d && huge[huge.length - 3] === 0x56)
  // the cut lands on a line boundary: the byte before the footer's ESC @ is an LF
  const footerAt = huge.lastIndexOf(Buffer.from([0x1b, 0x40]))
  check('truncation is at a line boundary, never mid-command', huge[footerAt - 1] === LF)

  const normal = renderKitchenTicket({ ...base, lines: [line(), line({ name: 'Fries', notes: 'no salt', modifiers: ['large'] })] })
  check('a normal ticket is untouched by the cap', normal.length < 600 && !/TRUNCATED/.test(normal.toString('latin1')))
  check('MAX_FIELD_LINES is what the encoder uses', MAX_FIELD_LINES === 12 && new EscPos(42).line('a\n'.repeat(100)).build().length < 200)

  // ── retention ─────────────────────────────────────────────────────────────
  loadEnv()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows
  const slug = 'testprintretention'
  const tenantId = (
    await q(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','restaurant')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, slug],
    )
  )[0].id as string
  const branchId = (
    await q(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
  )[0].id as string
  const printerId = (
    await q(`insert into printers (tenant_id,branch_id,name,kind,is_default,secret_hash) values ($1,$2,'P','kitchen',true,'x') returning id`, [tenantId, branchId])
  )[0].id as string
  const mk = async (status: string, ageDays: number) =>
    (
      await q(
        `insert into print_jobs (tenant_id,branch_id,printer_id,kind,title,payload,status,created_at)
         values ($1,$2,$3,'test','t',$4,$5, now() - make_interval(days => $6)) returning id`,
        [tenantId, branchId, printerId, Buffer.from('x'), status, ageDays],
      )
    )[0].id as string
  const old = { printed: await mk('printed', 45), cancelled: await mk('cancelled', 45), failed: await mk('failed', 45) }
  const live = { pending: await mk('pending', 45), sent: await mk('sent', 45) }
  const recent = await mk('printed', 5)
  const exists = async (id: string) => (await q('select 1 from print_jobs where id=$1', [id])).length === 1

  const removed = await pruneOldPrintJobs(pool)
  check('old printed / cancelled / failed jobs are removed', !(await exists(old.printed)) && !(await exists(old.cancelled)) && !(await exists(old.failed)), removed)
  check('old pending and sent jobs are never pruned', (await exists(live.pending)) && (await exists(live.sent)))
  check('recent finished jobs are kept', await exists(recent))
  check('a second sweep removes nothing more', (await pruneOldPrintJobs(pool)) === 0)
  check('a bad retention window is refused', await pruneOldPrintJobs(pool, 0).then(() => false, () => true))

  await q('delete from tenants where id=$1', [tenantId])
  console.log(`\n${pass} passed, ${fail} failed`)
  await pool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
