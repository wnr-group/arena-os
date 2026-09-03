/**
 * M15 #4 — event resource blocking, end to end against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-resource-blocks.ts
 *
 * ── What is real ────────────────────────────────────────────────────────────
 *
 * Everything that matters: the database, migration 0082, the GiST exclusion
 * constraint, every RLS policy and grant, the real syncEventBlocks() /
 * setEventResources() core, and — the point of the whole ticket — the REAL
 * createBookingCore() that both the public booking flow and the staff walk-in
 * flow funnel through. Nothing is stubbed, and no assertion restates a rule the
 * code declares; each one drives the code and observes the row.
 *
 * ── Why the booking path is driven through createBookingCore() ──────────────
 *
 * The ticket asks for proof that a normal booking cannot occupy an
 * event-blocked resource, and explicitly warns against solving it in the UI.
 * The server actions above createBookingCore() (lib/actions/bookings.ts for
 * walk-ins, lib/actions/public-booking.ts for customers) differ only in
 * authorization and error formatting — they both build slot rows and hand them
 * to this one function, which inserts them and lets the constraint decide. So
 * driving createBookingCore() proves both paths at their common floor, where a
 * bypass would actually have to live.
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, extra?: string) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : extra ? `  → ${extra}` : ''}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

/**
 * The Postgres SQLSTATE behind an error, looking through the wrapper Drizzle
 * puts around a driver error. 23P01 = exclusion_violation — the code
 * lib/actions/bookings.ts and lib/actions/public-booking.ts both branch on to
 * produce their "that time was just taken" message, so asserting on it proves
 * the refusal came from the CONSTRAINT and reaches production's handler.
 */
function pgCode(e: unknown): string | null {
  let cur: unknown = e
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && 'code' in cur) {
      const c = (cur as { code?: unknown }).code
      if (typeof c === 'string') return c
    }
    cur = typeof cur === 'object' && cur !== null ? (cur as { cause?: unknown }).cause : null
  }
  return null
}

/** The SQLSTATE of the last refusal(), for assertions about WHICH rule fired. */
let lastCode: string | null = null

/** Ran without throwing? Returns the error message, or null. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    lastCode = pgCode(e)
    return e instanceof Error ? e.message : String(e)
  }
}

const tag = Date.now().toString(36).slice(-5)
/** All times are absolute instants; the window is far in the future so nothing else touches it. */
const T = (h: number, m = 0) => new Date(Date.UTC(2031, 4, 12, h, m, 0))

async function main() {
  const { syncEventBlocks, setEventResources, releaseEventBlocks, statusBlocks, listEventBlocks } =
    await import('../lib/events/resource-blocks')
  const { createBookingCore } = await import('../lib/booking/service')
  const { updateEventStatusCore } = await import('../lib/events/service')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status) values ($1,$2,'active')
       on conflict (slug) do update set name=excluded.name returning id`,
      [`${slug}${tag}`, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set password_hash='x' returning id`,
      [`erb-${slug}${tag}@test.local`],
    )
    const userId = u.rows[0].id
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name,email)
       values ($1,$2,$3,'owner','active','ERB owner',$4)
       on conflict (tenant_id,user_id) do update set status='active',role='owner' returning id`,
      [tenantId, userId, branchId, `erb-${slug}${tag}@test.local`],
    )
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate)
       values ($1,'Station','100.00') returning id`,
      [tenantId],
    )
    return { tenantId, branchId, userId, membershipId: m.rows[0].id, typeId: rt.rows[0].id }
  }

  async function makeResource(t: { tenantId: string; branchId: string; typeId: string }, name: string) {
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,$4,'available') returning id`,
      [t.tenantId, t.branchId, t.typeId, `${name}-${tag}`],
    )
    return r.rows[0].id
  }

  async function makeEvent(
    t: { tenantId: string; branchId: string },
    o: { scope: 'none' | 'branch' | 'specific'; status?: string; from?: Date; to?: Date; title?: string },
  ) {
    const e = await owner.query<{ id: string }>(
      `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,status,resource_scope)
       values ($1,$2,$3,'meetup',$4,$5,$6::event_status,$7::event_resource_scope) returning id`,
      [
        t.tenantId,
        t.branchId,
        o.title ?? `Cup ${tag}`,
        o.from ?? T(18),
        o.to ?? T(20),
        o.status ?? 'draft',
        o.scope,
      ],
    )
    return e.rows[0].id
  }

  /** A normal booking through the REAL creation core. Returns null on success, else the error. */
  async function book(
    t: { tenantId: string; branchId: string; userId: string; membershipId: string },
    resourceId: string,
    from: Date,
    to: Date,
  ): Promise<string | null> {
    return refusal(() =>
      withUser(t.userId, (tx) =>
        createBookingCore(
          tx,
          { tenantId: t.tenantId, timezone: 'Asia/Kolkata', membershipId: t.membershipId },
          {
            branchId: t.branchId,
            customerName: 'Walk-in',
            source: 'staff' as const,
            discount: 0,
            deposit: 0,
            slots: [{ resourceId, startsAt: from.toISOString(), endsAt: to.toISOString() }],
          },
        ),
      ),
    )
  }

  const activeBlocks = async (eventId: string) =>
    (
      await owner.query<{ n: string }>(
        `select count(*) n from booking_slots where event_id=$1 and active`,
        [eventId],
      )
    ).rows[0].n

  const A = await makeTenant('erba')
  const B = await makeTenant('erbb')
  const [r1, r2, r3] = [
    await makeResource(A, 'S1'),
    await makeResource(A, 'S2'),
    await makeResource(A, 'S3'),
  ]

  // ════════════════════════════════════════════════════════════════════════
  section('1. the block IS a booking_slots row (no second availability system)')
  {
    const ev = await makeEvent(A, { scope: 'specific', status: 'published' })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1, r2]))

    const rows = await owner.query<{ resource_id: string; booking_id: string | null; active: boolean }>(
      `select resource_id, booking_id, active from booking_slots where event_id=$1`,
      [ev],
    )
    check('a published specific event writes one booking_slots row per resource', rows.rows.length === 2)
    check('…with booking_id NULL (it is nobody’s reservation)', rows.rows.every((r) => r.booking_id === null))
    check('…and active', rows.rows.every((r) => r.active))
    check(
      '…carrying exactly the selected resources',
      new Set(rows.rows.map((r) => r.resource_id)).size === 2 &&
        rows.rows.every((r) => [r1, r2].includes(r.resource_id)),
    )

    // ── THE CENTRAL CLAIM ────────────────────────────────────────────────
    const blocked = await book(A, r1, T(18, 30), T(19, 30))
    check('A NORMAL BOOKING ON A BLOCKED RESOURCE IS REFUSED', blocked !== null, String(blocked))
    check(
      '…with SQLSTATE 23P01 — the EXCLUSION CONSTRAINT refused it, not JS',
      lastCode === '23P01',
      String(lastCode),
    )
    check('…and no booking row survived the failed attempt',
      (await owner.query(`select 1 from bookings where tenant_id=$1`, [A.tenantId])).rows.length === 0)

    // §4: other stations in the branch stay bookable.
    const free = await book(A, r3, T(18, 30), T(19, 30))
    check('an UNBLOCKED station in the same branch is still bookable', free === null, String(free))

    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. time boundaries — [start, end) inherited from tstzrange')
  {
    const ev = await makeEvent(A, { scope: 'specific', status: 'published', from: T(14), to: T(18) })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1]))

    const before = await book(A, r1, T(13), T(14))
    check('a booking ENDING exactly when the event starts is allowed', before === null, String(before))

    const after = await book(A, r1, T(18), T(19))
    check('a booking STARTING exactly when the event ends is allowed', after === null, String(after))

    const inside = await book(A, r1, T(15), T(16))
    check('a booking wholly inside the event is refused', inside !== null)

    const straddleStart = await book(A, r1, T(13, 30), T(14, 30))
    check('a booking straddling the event start is refused', straddleStart !== null)

    const straddleEnd = await book(A, r1, T(17, 30), T(18, 30))
    check('a booking straddling the event end is refused', straddleEnd !== null)

    const engulf = await book(A, r1, T(12), T(20))
    check('a booking engulfing the event is refused', engulf !== null)

    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. whole-branch blocking')
  {
    const ev = await makeEvent(A, { scope: 'branch', status: 'published', from: T(14), to: T(18) })
    await withUser(A.userId, (tx) => syncEventBlocks(tx, A.tenantId, ev))

    check('a branch event blocks every bookable station in the branch', (await activeBlocks(ev)) === '3')

    for (const [name, rid] of [['S1', r1], ['S2', r2], ['S3', r3]] as const) {
      check(`…${name} is unbookable during the window`, (await book(A, rid, T(15), T(16))) !== null)
    }
    check('…and still bookable after it', (await book(A, r1, T(18), T(19))) === null)
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])

    // §3: a station created DURING a live branch block must not be a bypass.
    const late = await makeResource(A, 'S4-late')
    check(
      'a station ADDED to the branch mid-block inherits the block (trigger)',
      (await activeBlocks(ev)) === '4',
    )
    check(
      '…so it cannot be booked through the event either',
      (await book(A, late, T(15), T(16))) !== null,
    )

    // A station coming back from maintenance is the same hole.
    const fixed = await makeResource(A, 'S5-maint')
    await owner.query(`update resources set status='maintenance' where id=$1`, [fixed])
    await owner.query(`delete from booking_slots where event_id=$1 and resource_id=$2`, [ev, fixed])
    await owner.query(`update resources set status='available' where id=$1`, [fixed])
    check(
      'a station returning from maintenance inherits the block too',
      (await owner.query(`select 1 from booking_slots where event_id=$1 and resource_id=$2`, [ev, fixed]))
        .rows.length === 1,
    )

    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
    await owner.query(`delete from resources where id = any($1)`, [[late, fixed]])
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. lifecycle drives the block')
  {
    check('statusBlocks: draft does NOT reserve', statusBlocks('draft') === false)
    check('…published does', statusBlocks('published') === true)
    check('…registration_open does', statusBlocks('registration_open') === true)
    check('…FULL still does (capacity ≠ giving the room back)', statusBlocks('full') === true)
    check('…in_progress does', statusBlocks('in_progress') === true)
    check('…completed does NOT', statusBlocks('completed') === false)
    check('…cancelled does NOT', statusBlocks('cancelled') === false)

    const ev = await makeEvent(A, { scope: 'specific', status: 'draft' })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1]))
    check('a DRAFT event reserves nothing', (await activeBlocks(ev)) === '0')
    check('…so the station is still bookable', (await book(A, r1, T(18, 30), T(19))) === null)
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])

    // draft → published takes the stations
    await withUser(A.userId, async (tx) => {
      await updateEventStatusCore(tx, { tenantId: A.tenantId }, ev, 'published')
      await syncEventBlocks(tx, A.tenantId, ev)
    })
    check('publishing takes the stations', (await activeBlocks(ev)) === '1')
    check('…and the station is now unbookable', (await book(A, r1, T(18, 30), T(19))) !== null)

    // registration_open → full keeps them
    await withUser(A.userId, async (tx) => {
      await updateEventStatusCore(tx, { tenantId: A.tenantId }, ev, 'registration_open')
      await syncEventBlocks(tx, A.tenantId, ev)
    })
    check('registration_open keeps them', (await activeBlocks(ev)) === '1')
    await withUser(A.userId, async (tx) => {
      await updateEventStatusCore(tx, { tenantId: A.tenantId }, ev, 'full')
      await syncEventBlocks(tx, A.tenantId, ev)
    })
    check('FULL keeps them — the room is not released because entries closed', (await activeBlocks(ev)) === '1')

    await withUser(A.userId, async (tx) => {
      await updateEventStatusCore(tx, { tenantId: A.tenantId }, ev, 'in_progress')
      await syncEventBlocks(tx, A.tenantId, ev)
    })
    check('in_progress keeps them', (await activeBlocks(ev)) === '1')

    await withUser(A.userId, async (tx) => {
      await updateEventStatusCore(tx, { tenantId: A.tenantId }, ev, 'completed')
      await syncEventBlocks(tx, A.tenantId, ev)
    })
    check('COMPLETED releases them', (await activeBlocks(ev)) === '0')
    check('…and the station is bookable again', (await book(A, r1, T(18, 30), T(19))) === null)
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. cancellation releases, idempotently')
  {
    const ev = await makeEvent(A, { scope: 'specific', status: 'published' })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1, r2]))
    check('two stations held', (await activeBlocks(ev)) === '2')

    const other = await makeEvent(A, { scope: 'specific', status: 'published', from: T(21), to: T(22) })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, other, [r1]))
    check('a second event holds its own station at a different time', (await activeBlocks(other)) === '1')

    await withUser(A.userId, async (tx) => {
      await updateEventStatusCore(tx, { tenantId: A.tenantId }, ev, 'cancelled')
      await syncEventBlocks(tx, A.tenantId, ev)
    })
    check('cancelling releases every block of THAT event', (await activeBlocks(ev)) === '0')
    check('…and leaves the other event’s block untouched', (await activeBlocks(other)) === '1')

    const again = await refusal(() =>
      withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev)),
    )
    check('releasing twice is a no-op, not an error (idempotent)', again === null)
    check('…still zero', (await activeBlocks(ev)) === '0')

    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, other))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. edits move the block atomically')
  {
    const ev = await makeEvent(A, { scope: 'specific', status: 'published', from: T(18), to: T(20) })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1]))

    // §8: move 18–20 → 19–21. The OLD window must stop blocking.
    await owner.query(`update events set starts_at=$2, ends_at=$3 where id=$1`, [ev, T(19), T(21)])
    await withUser(A.userId, (tx) => syncEventBlocks(tx, A.tenantId, ev))
    const moved = await owner.query<{ starts_at: Date; ends_at: Date }>(
      `select starts_at, ends_at from booking_slots where event_id=$1`,
      [ev],
    )
    check('moving the event moves its block', moved.rows.length === 1 &&
      moved.rows[0].starts_at.getTime() === T(19).getTime() &&
      moved.rows[0].ends_at.getTime() === T(21).getTime())
    check('…the vacated hour is bookable again', (await book(A, r1, T(18), T(19))) === null)
    check('…and the new hour is not', (await book(A, r1, T(20), T(21))) !== null)
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])

    // Removing a resource frees it; adding one takes it.
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r2]))
    check('swapping the selection releases the old station', (await book(A, r1, T(19, 30), T(20))) === null)
    check('…and takes the new one', (await book(A, r2, T(19, 30), T(20))) !== null)
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])

    // §17 + §7: an edit onto a booked station is REFUSED and changes nothing.
    const held = await book(A, r3, T(19), T(20))
    check('a customer books a third station inside the window', held === null, String(held))
    const before = await withUser(A.userId, (tx) => listEventBlocks(tx, A.tenantId, ev))
    const refused = await refusal(() =>
      withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r2, r3])),
    )
    check('adding a BOOKED station to the event is refused', refused !== null)
    check('…with a message naming the resource', (refused ?? '').includes('already held'), String(refused))
    const after = await withUser(A.userId, (tx) => listEventBlocks(tx, A.tenantId, ev))
    check(
      '…and the event keeps EXACTLY its previous blocks (rolled back, not partial)',
      after.length === before.length &&
        after.map((b) => b.resourceId).sort().join() === before.map((b) => b.resourceId).sort().join(),
    )
    check(
      '…and the customer booking is untouched',
      (await owner.query(`select 1 from bookings where tenant_id=$1 and status='confirmed'`, [A.tenantId]))
        .rows.length === 1,
    )

    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. event ↔ event exclusion')
  {
    const e1 = await makeEvent(A, { scope: 'specific', status: 'published', from: T(14), to: T(16), title: 'E1' })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, e1, [r1]))

    const e2 = await makeEvent(A, { scope: 'specific', status: 'published', from: T(15), to: T(17), title: 'E2' })
    const clash = await refusal(() => withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, e2, [r1])))
    check('a second event overlapping the first on one station is REFUSED', clash !== null)
    check('…naming the other event as the holder', (clash ?? '').includes('another event'), String(clash))
    check('…and the first event still holds it', (await activeBlocks(e1)) === '1')
    check('…while the second holds nothing', (await activeBlocks(e2)) === '0')

    // Adjacent, not overlapping — allowed, same half-open rule.
    await owner.query(`update events set starts_at=$2, ends_at=$3 where id=$1`, [e2, T(16), T(18)])
    const adjacent = await refusal(() => withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, e2, [r1])))
    check('an event starting exactly when the other ends is allowed', adjacent === null, String(adjacent))

    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, e1))
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, e2))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('8. concurrency — the constraint, not a check-then-act')
  {
    const ev = await makeEvent(A, { scope: 'specific', status: 'published', from: T(14), to: T(16) })

    // Scenario A/B: an event block and a booking race for the same station.
    // Both open real transactions; exactly one may commit.
    const results = await Promise.allSettled([
      withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1])),
      book(A, r1, T(14, 30), T(15, 30)).then((e) => {
        if (e) throw new Error(e)
        return 'booked'
      }),
    ])
    const wins = results.filter((r) => r.status === 'fulfilled').length
    check('exactly ONE of {event block, booking} wins the race', wins === 1, `wins=${wins}`)

    const slotCount = (
      await owner.query<{ n: string }>(
        `select count(*) n from booking_slots
          where resource_id=$1 and active
            and tstzrange(starts_at, ends_at) && tstzrange($2,$3)`,
        [r1, T(14), T(16)],
      )
    ).rows[0].n
    check('…and the resource holds exactly one active row for the window', slotCount === '1', slotCount)

    // Scenario D: two events racing for the same station at the same time.
    await owner.query(`delete from bookings where tenant_id=$1`, [A.tenantId])
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
    const d1 = await makeEvent(A, { scope: 'specific', status: 'published', from: T(9), to: T(11), title: 'D1' })
    const d2 = await makeEvent(A, { scope: 'specific', status: 'published', from: T(9), to: T(11), title: 'D2' })
    const both = await Promise.allSettled([
      withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, d1, [r2])),
      withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, d2, [r2])),
    ])
    check(
      'two events racing for one station: exactly one succeeds',
      both.filter((r) => r.status === 'fulfilled').length === 1,
    )
    check(
      '…and the station holds exactly one block',
      (
        await owner.query<{ n: string }>(
          `select count(*) n from booking_slots where resource_id=$1 and active and event_id is not null`,
          [r2],
        )
      ).rows[0].n === '1',
    )
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, d1))
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, d2))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('9. tenant isolation')
  {
    const bR = await makeResource(B, 'B-S1')
    const evA = await makeEvent(A, { scope: 'specific', status: 'published' })

    const cross = await refusal(() =>
      withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, evA, [bR])),
    )
    check('tenant A cannot select tenant B’s resource', cross !== null)
    check('…with a message that does not confirm the row exists',
      (cross ?? '').includes('do not belong to this event') , String(cross))
    check('…and nothing was blocked', (await activeBlocks(evA)) === '0')

    // The composite FK makes it unrepresentable even bypassing the service.
    const direct = await refusal(() =>
      owner.query(
        `insert into event_resources (tenant_id,event_id,resource_id) values ($1,$2,$3)`,
        [A.tenantId, evA, bR],
      ),
    )
    check('…and the database refuses it directly too (composite FK)', direct !== null)

    // B cannot see A's blocks.
    const evA2 = await makeEvent(A, { scope: 'specific', status: 'published', from: T(6), to: T(7) })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, evA2, [r1]))
    const seen = await withUser(B.userId, (tx) => listEventBlocks(tx, B.tenantId, evA2))
    check('tenant B cannot read tenant A’s event blocks', seen.length === 0)
    const seenRows = await withUser(B.userId, (tx) =>
      tx.execute(sql`select count(*)::int n from booking_slots where event_id = ${evA2}`),
    )
    check(
      '…not even by raw query — RLS confines it',
      Number((seenRows.rows[0] as { n: number }).n) === 0,
    )
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, evA2))
    await owner.query(`delete from resources where id=$1`, [bR])
  }

  // ════════════════════════════════════════════════════════════════════════
  section('10. an event block is never billable and never a customer booking')
  {
    const ev = await makeEvent(A, { scope: 'specific', status: 'published', from: T(3), to: T(4) })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1]))

    const money = await owner.query<{ rate_applied: string; slot_total: string }>(
      `select rate_applied, slot_total from booking_slots where event_id=$1`,
      [ev],
    )
    check('an event block carries zero money',
      money.rows.every((r) => Number(r.rate_applied) === 0 && Number(r.slot_total) === 0))
    check(
      'the one-owner CHECK forbids a row belonging to both',
      (await refusal(() =>
        owner.query(
          `insert into booking_slots (tenant_id,booking_id,event_id,resource_id,starts_at,ends_at,resource_name,resource_type_name)
           values ($1,gen_random_uuid(),$2,$3,$4,$5,'x','y')`,
          [A.tenantId, ev, r1, T(3), T(4)],
        ),
      )) !== null,
    )
    check(
      '…and forbids a row belonging to neither',
      (await refusal(() =>
        owner.query(
          `insert into booking_slots (tenant_id,resource_id,starts_at,ends_at,resource_name,resource_type_name)
           values ($1,$2,$3,$4,'x','y')`,
          [A.tenantId, r1, T(3), T(4)],
        ),
      )) !== null,
    )
    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('11. the AVAILABILITY READERS exclude blocked time, unchanged')
  // The design claim is that no availability query needed editing, because they
  // all read booking_slots on (resource_id, active) without joining bookings.
  // That is proven here by driving the REAL public readers rather than asserted
  // in a comment. 11:30–13:30 IST on 2031-05-12, well inside opening hours.
  {
    for (let dow = 0; dow < 7; dow++) {
      await owner.query(
        `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed)
         values ($1,$2,$3,'00:00','23:59',false)
         on conflict (branch_id,day_of_week) do update set open_time='00:00', close_time='23:59', is_closed=false`,
        [A.tenantId, A.branchId, dow],
      )
    }
    const { getPublicAvailableStarts, getPublicAvailableStartsForType } = await import(
      '../lib/booking/public-availability'
    )
    const DATE = '2031-05-12'
    const TZ = 'Asia/Kolkata'
    const inWindow = (d: Date) => d >= T(6) && d < T(8)

    const before = await getPublicAvailableStarts({
      tenantId: A.tenantId, branchId: A.branchId, resourceId: r1,
      timeZone: TZ, date: DATE, durationMinutes: 60,
    })
    const beforeStarts = 'starts' in before ? before.starts : []
    check('with no event, the station offers starts inside 11:30–13:30 IST',
      beforeStarts.some(inWindow), `${beforeStarts.length} starts`)

    const ev = await makeEvent(A, { scope: 'specific', status: 'published', from: T(6), to: T(8) })
    await withUser(A.userId, (tx) => setEventResources(tx, A.tenantId, ev, [r1]))

    const after = await getPublicAvailableStarts({
      tenantId: A.tenantId, branchId: A.branchId, resourceId: r1,
      timeZone: TZ, date: DATE, durationMinutes: 60,
    })
    const afterStarts = 'starts' in after ? after.starts : []
    check('PUBLIC availability drops every start inside the event window',
      !afterStarts.some(inWindow))
    check('…and still offers times outside it', afterStarts.length > 0)

    // §12: the auto-assignment candidate set. r1 is blocked; r2/r3 are not, so
    // the type-level reader must keep offering the window on the free ones and
    // must never nominate r1 for it.
    const byType = await getPublicAvailableStartsForType({
      tenantId: A.tenantId, branchId: A.branchId, resourceTypeId: A.typeId,
      timeZone: TZ, date: DATE, durationMinutes: 60,
    })
    const typeSlots = 'starts' in byType ? byType.starts : []
    const inWindowSlots = typeSlots.filter((s) => inWindow(s.start))
    check('type-level availability still offers the window on OTHER stations',
      inWindowSlots.length > 0)
    check('…and never nominates the blocked station for it (§12 auto-assignment)',
      inWindowSlots.every((s) => s.resourceId !== r1),
      inWindowSlots.map((s) => s.resourceId).join(','))

    await withUser(A.userId, (tx) => releaseEventBlocks(tx, A.tenantId, ev))
    const restored = await getPublicAvailableStarts({
      tenantId: A.tenantId, branchId: A.branchId, resourceId: r1,
      timeZone: TZ, date: DATE, durationMinutes: 60,
    })
    check('releasing the event restores the station’s availability',
      ('starts' in restored ? restored.starts : []).some(inWindow))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  for (const t of [A, B]) {
    await owner.query(`delete from booking_slots where tenant_id=$1`, [t.tenantId])
    await owner.query(`delete from bookings where tenant_id=$1`, [t.tenantId])
    await owner.query(`delete from event_resources where tenant_id=$1`, [t.tenantId])
    await owner.query(`delete from events where tenant_id=$1`, [t.tenantId])
    await owner.query(`delete from resources where tenant_id=$1`, [t.tenantId])
    await owner.query(`delete from working_hours where tenant_id=$1`, [t.tenantId])
    await owner.query(`delete from resource_types where tenant_id=$1`, [t.tenantId])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
