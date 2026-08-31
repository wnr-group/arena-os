/**
 * The portal's booking readers (AROS-89), against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-portal-bookings.ts
 *
 * Drives readPortalBookings() / readPortalBooking() — the actual functions the
 * pages call — inside a real withCustomer() transaction. scripts/
 * verify-customer-portal-rls.ts proves the POLICIES in raw SQL; this proves the
 * QUERIES, their upcoming/past classification, their ordering, and the shape of
 * what they hand the UI.
 *
 * The last of those matters more than it looks. Drizzle's raw execute() returns
 * timestamptz as a STRING rather than a Date; a string is truthy, so it slips
 * past a null-check and only dies inside Intl with "RangeError: Invalid time
 * value" — and only for customers who actually HAVE bookings, which an
 * empty-state test never exercises. The type assertions below are that
 * regression guard.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { readPortalBookings, readPortalBooking } = await import('../lib/portal/bookings')
  const { readPortalSummary } = await import('../lib/portal/account')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withCustomer. */
  async function withCustomer<T>(customerId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${customerId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ('pbook', 'pbook co', 'active')
     on conflict (slug) do update set status = 'active' returning id`,
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id, name, is_primary) values ($1, 'Main', true)
     on conflict (tenant_id, name) do update set is_primary = true returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id

  async function wipe() {
    await owner.query('delete from booking_slots where tenant_id = $1', [tenantId])
    await owner.query('delete from bookings where tenant_id = $1', [tenantId])
    await owner.query('delete from resources where tenant_id = $1', [tenantId])
    await owner.query('delete from resource_types where tenant_id = $1', [tenantId])
    await owner.query('delete from customers where tenant_id = $1', [tenantId])
  }
  await wipe()

  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id, name, hourly_rate) values ($1, 'Booth', '100')
     on conflict (tenant_id, name) do update set name = excluded.name returning id`,
    [tenantId],
  )
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id, branch_id, resource_type_id, name)
     values ($1, $2, $3, 'Booth 1')
     on conflict (tenant_id, name) do update set name = excluded.name returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const res2 = await owner.query<{ id: string }>(
    `insert into resources (tenant_id, branch_id, resource_type_id, name)
     values ($1, $2, $3, 'Booth 2')
     on conflict (tenant_id, name) do update set name = excluded.name returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )

  async function makeCustomer(phone: string, name: string) {
    const c = await owner.query<{ id: string }>(
      `insert into customers (tenant_id, phone, name) values ($1,$2,$3) returning id`,
      [tenantId, phone, name],
    )
    return c.rows[0].id
  }

  const alice = await makeCustomer('+919000009001', 'Alice')
  const bob = await makeCustomer('+919000009002', 'Bob')

  let seq = 0
  async function makeBooking(
    customerId: string,
    status: string,
    startOffset: string | null,
    endOffset: string | null,
    total = '100.00',
    resourceIds: string[] = [res.rows[0].id],
  ) {
    seq++
    const b = await owner.query<{ id: string }>(
      `insert into bookings
         (tenant_id, branch_id, customer_id, booking_number, customer_name, status, source,
          subtotal, total)
       values ($1,$2,$3,$4,'x',$5::booking_status,'online',$6,$6) returning id`,
      [tenantId, branchId, customerId, `BK-T-${seq}`, status, total],
    )
    if (startOffset && endOffset) {
      for (const resourceId of resourceIds) {
        const name = resourceId === res.rows[0].id ? 'Booth 1' : 'Booth 2'
        await owner.query(
          `insert into booking_slots
             (tenant_id, booking_id, resource_id, starts_at, ends_at,
              resource_name, resource_type_name, active)
           values ($1,$2,$3, now() + $4::interval, now() + $5::interval, $6, 'Booth',
                   $7::booking_status not in ('cancelled','no_show'))`,
          [tenantId, b.rows[0].id, resourceId, startOffset, endOffset, name, status],
        )
      }
    }
    return b.rows[0].id
  }

  // Alice: one of each interesting case.
  const future = await makeBooking(alice, 'confirmed', '5 days', '5 days 2 hours', '500.00')
  const soon = await makeBooking(alice, 'confirmed', '1 day', '1 day 2 hours', '100.00')
  const inProgress = await makeBooking(alice, 'checked_in', '-1 hour', '1 hour', '250.00')
  // Deliberately on the OTHER resource: booking_slots_no_overlap (0003) is a
  // real exclusion constraint, and two live slots on one resource at the same
  // time cannot exist — which is exactly what it is there to guarantee.
  const overnight = await makeBooking(alice, 'confirmed', '-3 hours', '4 hours', '400.00', [
    res2.rows[0].id,
  ])
  const completed = await makeBooking(alice, 'completed', '-10 days', '-10 days + 2 hours', '80.00')
  const cancelled = await makeBooking(alice, 'cancelled', '-4 days', '-4 days + 2 hours', '0.00')
  const noShow = await makeBooking(alice, 'no_show', '-6 days', '-6 days + 2 hours', '60.00')
  const stale = await makeBooking(alice, 'confirmed', '-2 days', '-2 days + 2 hours', '120.00')
  const slotless = await makeBooking(alice, 'confirmed', null, null, '10.00')
  const multi = await makeBooking(alice, 'confirmed', '7 days', '7 days 3 hours', '900.00', [
    res.rows[0].id,
    res2.rows[0].id,
  ])

  const bobBooking = await makeBooking(bob, 'confirmed', '2 days', '2 days 2 hours', '777.00')

  // ══ 1. classification ══════════════════════════════════════════════════════
  console.log('\n── upcoming vs past ──')

  const lists = await withCustomer(alice, (tx) => readPortalBookings(tx, tenantId))
  const upIds = lists.upcoming.map((b) => b.id)
  const pastIds = lists.past.map((b) => b.id)

  check('a future confirmed booking is upcoming', upIds.includes(future))
  check('a booking happening right now is upcoming', upIds.includes(inProgress))
  check('an overnight booking mid-span is upcoming', upIds.includes(overnight))
  check('a multi-resource booking is upcoming', upIds.includes(multi))
  check('completed is past', pastIds.includes(completed))
  check('cancelled is past', pastIds.includes(cancelled))
  check('no_show is past (the status the ticket does not mention)', pastIds.includes(noShow))
  check(
    'a confirmed booking whose time has passed is past, not lost',
    pastIds.includes(stale) && !upIds.includes(stale),
  )
  check('a slotless booking still appears somewhere', [...upIds, ...pastIds].includes(slotless))

  // The property that makes the two sections trustworthy.
  const total = await owner.query<{ n: string }>(
    'select count(*) n from bookings where tenant_id = $1 and customer_id = $2',
    [tenantId, alice],
  )
  check(
    'upcoming + past partition EVERY booking exactly once',
    upIds.length + pastIds.length === Number(total.rows[0].n) &&
      new Set([...upIds, ...pastIds]).size === Number(total.rows[0].n),
  )

  // ══ 2. ordering ════════════════════════════════════════════════════════════
  console.log('\n── ordering ──')

  check(
    'upcoming is soonest-first',
    upIds.indexOf(inProgress) < upIds.indexOf(soon) && upIds.indexOf(soon) < upIds.indexOf(future),
  )
  check('…and the furthest-out booking is last of the timed ones', upIds.indexOf(multi) > upIds.indexOf(future))
  check(
    'past is newest-first',
    pastIds.indexOf(stale) < pastIds.indexOf(cancelled) &&
      pastIds.indexOf(cancelled) < pastIds.indexOf(noShow) &&
      pastIds.indexOf(noShow) < pastIds.indexOf(completed),
  )

  // ══ 3. shape — the regression guard ════════════════════════════════════════
  console.log('\n── returned shape ──')

  const timed = lists.upcoming.find((b) => b.id === future)!
  check('startsAt is a real Date, not a driver string', timed.startsAt instanceof Date)
  check('endsAt is a real Date, not a driver string', timed.endsAt instanceof Date)
  check('…and the Date is valid', !Number.isNaN(timed.startsAt!.getTime()))
  check('createdAt is a Date', timed.createdAt instanceof Date)
  check('resourceNames is an array', Array.isArray(timed.resourceNames))
  check('…naming the denormalised resource', timed.resourceNames.includes('Booth 1'))

  const multiRow = lists.upcoming.find((b) => b.id === multi)!
  check('a multi-resource booking lists BOTH resources', multiRow.resourceNames.length === 2)
  check(
    '…and spans from the first slot to the last',
    multiRow.endsAt!.getTime() - multiRow.startsAt!.getTime() >= 3 * 3600_000,
  )

  const slotlessRow = [...lists.upcoming, ...lists.past].find((b) => b.id === slotless)!
  check('a slotless booking has null startsAt (not an invalid Date)', slotlessRow.startsAt === null)
  check('…and an empty resource list, not [null]', slotlessRow.resourceNames.length === 0)

  check('total is the STORED value, verbatim', timed.total === '500.00')

  // A cancelled booking keeps its times even though its slots went inactive.
  const cancelledRow = lists.past.find((b) => b.id === cancelled)!
  check('a cancelled booking still knows when it was', cancelledRow.startsAt instanceof Date)

  // ══ 4. isolation ═══════════════════════════════════════════════════════════
  console.log('\n── isolation ──')

  check("Bob's booking is absent from Alice's lists", ![...upIds, ...pastIds].includes(bobBooking))

  const bobLists = await withCustomer(bob, (tx) => readPortalBookings(tx, tenantId))
  check('Bob sees exactly his own one booking', bobLists.upcoming.length === 1)
  check('…and no history', bobLists.past.length === 0)
  check('…and it is his', bobLists.upcoming[0].id === bobBooking)

  // ══ 5. detail ══════════════════════════════════════════════════════════════
  console.log('\n── detail reader ──')

  const detail = await withCustomer(alice, (tx) => readPortalBooking(tx, tenantId, future))
  check('Alice can read her own booking detail', detail?.id === future)
  check('…with slots as Dates', detail!.slots[0].startsAt instanceof Date)
  check('…and the stored money columns', detail!.total === '500.00' && detail!.subtotal === '500.00')
  check('…and a confirmation token for the shareable page', Boolean(detail!.confirmationToken))

  const stolen = await withCustomer(alice, (tx) => readPortalBooking(tx, tenantId, bobBooking))
  check("Alice reading BOB'S booking id returns null (→ 404)", stolen === null)

  const bobOwn = await withCustomer(bob, (tx) => readPortalBooking(tx, tenantId, bobBooking))
  check('…while Bob reads the very same id fine', bobOwn?.id === bobBooking)

  const unknown = await withCustomer(alice, (tx) =>
    readPortalBooking(tx, tenantId, '00000000-0000-0000-0000-000000000000'),
  )
  check('an unknown uuid returns null, same as "not yours"', unknown === null)

  const malformed = await withCustomer(alice, (tx) => readPortalBooking(tx, tenantId, 'not-a-uuid'))
  check('a malformed id returns null rather than throwing 22P02', malformed === null)

  const injection = await withCustomer(alice, (tx) =>
    readPortalBooking(tx, tenantId, "' or '1'='1"),
  )
  check('an injection attempt returns null', injection === null)

  const multiDetail = await withCustomer(alice, (tx) => readPortalBooking(tx, tenantId, multi))
  check('a multi-slot booking returns every slot', multiDetail!.slots.length === 2)
  check(
    '…ordered by start time',
    multiDetail!.slots[0].startsAt.getTime() <= multiDetail!.slots[1].startsAt.getTime(),
  )

  // ══ 6. cancellation (AROS-90) ══════════════════════════════════════════════
  console.log('\n── cancellation ──')

  const { cancelOwnBooking, checkCancelEligibility, getCancellationPolicy } = await import(
    '../lib/portal/cancel'
  )

  const policy = await withCustomer(alice, (tx) => getCancellationPolicy(tx, tenantId))
  check(
    'a tenant with no settings row gets the documented defaults (on, 24h)',
    policy.enabled && policy.cutoffHours === 24,
  )

  const cancellable = await makeBooking(alice, 'confirmed', '9 days', '9 days 2 hours', '300.00')
  const withinCutoff = await makeBooking(alice, 'confirmed', '6 hours', '8 hours', '300.00')
  const withDeposit = await makeBooking(alice, 'confirmed', '11 days', '11 days 2 hours', '400.00')
  await owner.query('update bookings set deposit = $1 where id = $2', ['150.00', withDeposit])

  // ── the happy path ──
  const before = await owner.query<{ active: boolean }>(
    'select active from booking_slots where booking_id = $1',
    [cancellable],
  )
  check('the slot starts out active', before.rows[0].active === true)

  const ok = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: cancellable, tenantId, customerId: alice }),
  )
  check('Alice can cancel her own eligible upcoming booking', ok.ok === true)
  check(
    '…and it is not flagged for deposit review (there is no deposit)',
    ok.ok === true && !ok.depositReviewRequired,
  )

  const after = await owner.query<{ status: string; cancelled_at: Date | null }>(
    'select status, cancelled_at from bookings where id = $1',
    [cancellable],
  )
  check('the booking status is now cancelled', after.rows[0].status === 'cancelled')
  check('cancelled_at is populated', after.rows[0].cancelled_at instanceof Date)

  const slotAfter = await owner.query<{ active: boolean }>(
    'select active from booking_slots where booking_id = $1',
    [cancellable],
  )
  check(
    'the slot was freed by the EXISTING trigger, not by hand (active = false)',
    slotAfter.rows[0].active === false,
  )

  const audit = await owner.query<{
    action: string
    actor_membership_id: string | null
    after: Record<string, unknown>
  }>(
    `select action, actor_membership_id, "after" from audit_log
      where entity_id = $1 order by created_at desc limit 1`,
    [cancellable],
  )
  check('an audit row was written', audit.rows[0]?.action === 'booking.cancelled_by_customer')
  check('…with no staff actor', audit.rows[0]?.actor_membership_id === null)
  check('…naming the customer who did it', audit.rows[0]?.after.customerId === alice)

  // ── already cancelled ──
  const twice = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: cancellable, tenantId, customerId: alice }),
  )
  check(
    'cancelling the same booking twice is refused',
    twice.ok === false && twice.reason === 'wrong_status',
  )

  // ── terminal states ──
  for (const [label, id] of [
    ['completed', completed],
    ['no_show', noShow],
  ] as const) {
    const r = await withCustomer(alice, (tx) =>
      cancelOwnBooking(tx, { bookingId: id, tenantId, customerId: alice }),
    )
    check(`a ${label} booking cannot be cancelled`, r.ok === false && r.reason === 'wrong_status')
  }

  // checked_in is excluded on purpose — the customer is already at the venue.
  const ci = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: inProgress, tenantId, customerId: alice }),
  )
  check(
    'a checked-in booking cannot be self-cancelled',
    ci.ok === false && ci.reason === 'wrong_status',
  )

  // ── the cutoff ──
  const tooLate = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: withinCutoff, tenantId, customerId: alice }),
  )
  check(
    'a booking inside the cutoff is refused',
    tooLate.ok === false && tooLate.reason === 'within_cutoff',
  )
  const stillConfirmed = await owner.query<{ status: string }>(
    'select status from bookings where id = $1',
    [withinCutoff],
  )
  check('…and it is genuinely untouched', stillConfirmed.rows[0].status === 'confirmed')

  // A tenant that widens the cutoff to 0 lets the same booking through.
  await owner.query(
    `insert into booking_cancellation_settings (tenant_id, cutoff_hours) values ($1, 0)
     on conflict (tenant_id) do update set cutoff_hours = 0, customer_cancellation_enabled = true`,
    [tenantId],
  )
  const nowAllowed = await withCustomer(alice, (tx) =>
    checkCancelEligibility(tx, withinCutoff, tenantId),
  )
  check('with cutoff_hours = 0 the same booking becomes cancellable', nowAllowed.ok === true)

  // …and one that turns self-service off blocks everything.
  await owner.query(
    'update booking_cancellation_settings set customer_cancellation_enabled = false where tenant_id = $1',
    [tenantId],
  )
  const disabled = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: withinCutoff, tenantId, customerId: alice }),
  )
  check(
    'self-service can be switched off per tenant',
    disabled.ok === false && disabled.reason === 'disabled',
  )
  await owner.query('delete from booking_cancellation_settings where tenant_id = $1', [tenantId])

  // ── deposit: flagged, never refunded ──
  const depositCancel = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: withDeposit, tenantId, customerId: alice }),
  )
  check('a booking with a deposit can still be cancelled', depositCancel.ok === true)
  check(
    '…and comes back flagged for staff review',
    depositCancel.ok === true && depositCancel.depositReviewRequired === true,
  )
  const flagged = await owner.query<{ deposit_review_required: boolean; deposit: string }>(
    'select deposit_review_required, deposit from bookings where id = $1',
    [withDeposit],
  )
  check('the flag is persisted on the booking', flagged.rows[0].deposit_review_required === true)
  check('…and the deposit amount is untouched', flagged.rows[0].deposit === '150.00')

  const refundRows = await owner.query('select id from refunds where tenant_id = $1', [tenantId])
  check('NO refund row was created', refundRows.rowCount === 0)
  const paymentRows = await owner.query('select id from payments where tenant_id = $1', [tenantId])
  check('NO payment row was created', paymentRows.rowCount === 0)

  // ── cross-customer ──
  const bobTarget = await makeBooking(bob, 'confirmed', '9 days', '9 days 2 hours', '600.00', [
    res2.rows[0].id,
  ])
  const steal = await withCustomer(alice, (tx) =>
    cancelOwnBooking(tx, { bookingId: bobTarget, tenantId, customerId: alice }),
  )
  check("Alice CANNOT cancel Bob's booking", steal.ok === false)
  check(
    '…and is told only that it was not found',
    steal.ok === false && steal.reason === 'not_found',
  )
  const bobIntact = await owner.query<{ status: string }>(
    'select status from bookings where id = $1',
    [bobTarget],
  )
  check("…and Bob's booking is genuinely untouched", bobIntact.rows[0].status === 'confirmed')
  const bobSlot = await owner.query<{ active: boolean }>(
    'select active from booking_slots where booking_id = $1',
    [bobTarget],
  )
  check("…and Bob's slot is still held", bobSlot.rows[0].active === true)

  // Even with the application layer bypassed entirely, RLS alone must refuse.
  await app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.customer_id', ${alice}, true)`)
    const r = await tx.execute(
      sql`update public.bookings set status = 'cancelled', cancelled_at = now()
           where id = ${bobTarget}::uuid`,
    )
    check("raw SQL as Alice cannot cancel Bob's booking either (RLS)", r.rowCount === 0)
  })

  // …and the policy must refuse transitions it does not permit, on her OWN row.
  //
  // Note the two different shapes of refusal, both of which count as blocked:
  // an UPDATE whose OLD row fails the USING clause matches nothing and reports
  // 0 rows, while one whose NEW row fails WITH CHECK raises 42501 outright.
  // Writing 'completed' on her own confirmed booking is the second kind — the
  // row is visible to her, the resulting row is simply not allowed to exist.
  const aliceOpen = await makeBooking(alice, 'confirmed', '12 days', '12 days 2 hours', '100.00')

  async function customerUpdateBlocked(label: string, statement: ReturnType<typeof sql>) {
    let refused = false
    try {
      await app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.customer_id', ${alice}, true)`)
        const r = await tx.execute(statement)
        refused = r.rowCount === 0
      })
    } catch {
      refused = true // WITH CHECK violation (42501)
    }
    check(label, refused)
  }

  await customerUpdateBlocked(
    'a customer cannot mark their own booking completed (RLS)',
    sql`update public.bookings set status = 'completed' where id = ${aliceOpen}::uuid`,
  )
  await customerUpdateBlocked(
    'a customer cannot zero their own total (RLS)',
    sql`update public.bookings set total = 0 where id = ${aliceOpen}::uuid`,
  )
  await customerUpdateBlocked(
    'a customer cannot un-cancel a cancelled booking (RLS)',
    sql`update public.bookings set status = 'confirmed' where id = ${cancellable}::uuid`,
  )

  const untouched = await owner.query<{ status: string; total: string }>(
    'select status, total from bookings where id = $1',
    [aliceOpen],
  )
  check(
    '…and the booking is genuinely unchanged after all three attempts',
    untouched.rows[0].status === 'confirmed' && untouched.rows[0].total === '100.00',
  )

  // ── the slot really is available again ──
  // The exclusion constraint is the ultimate authority on whether time is free,
  // so re-booking the cancelled window is the only assertion that proves it.
  const reuse = await makeBooking(bob, 'confirmed', '9 days', '9 days 2 hours', '100.00')
  const reuseSlot = await owner.query<{ n: string }>(
    'select count(*) n from booking_slots where booking_id = $1 and active',
    [reuse],
  )
  check(
    'the freed window can be booked again (booking_slots_no_overlap allows it)',
    Number(reuseSlot.rows[0].n) === 1,
  )

  // …while a window that is still held cannot be taken.
  let blocked = false
  try {
    await makeBooking(bob, 'confirmed', '12 days', '12 days 2 hours', '100.00')
  } catch {
    blocked = true
  }
  check('…but a still-active window is still protected from double-booking', blocked)

  // ══ the overview count must agree with THIS page ═══════════════════════════
  //
  // The two surfaces answer the same question — "how many bookings are still
  // ahead of me?" — from two different queries, and they used to disagree. The
  // overview counted status alone (confirmed/checked_in, no time test) while the
  // list splits on whether the booking has actually finished. A confirmed
  // booking whose slot ended yesterday and was never marked completed was
  // therefore counted as upcoming on the overview and shown under Past here, so
  // at the end of a busy day the overview advertised upcoming bookings the list
  // showed none of.
  //
  // These assertions pin the two together. They are written against the numbers
  // a customer actually sees, not against the SQL, so they would still catch a
  // future divergence introduced a different way.
  console.log('\n── overview count agrees with the list ──')

  // No wipe(): it drops the shared resources these fixtures reference, and it is
  // not needed — both readers run under withCustomer(), so RLS scopes every count
  // and every list to this one fresh customer regardless of what else exists.
  const agreeCustomer = await makeCustomer('+919000000901', 'Agree')

  // A resource of its own, so these fixtures cannot collide with the slots
  // earlier sections left behind on Booth 1/2 (booking_slots_no_overlap is an
  // exclusion constraint over ACTIVE slots per resource).
  const agreeRes = await owner.query<{ id: string }>(
    `insert into resources (tenant_id, branch_id, resource_type_id, name)
     values ($1, $2, $3, 'Agree Booth')
     on conflict (tenant_id, name) do update set name = excluded.name returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const agreeResIds = [agreeRes.rows[0].id]

  // THE case that was broken: confirmed, but its slot finished yesterday.
  await makeBooking(agreeCustomer, 'confirmed', '-2 days', '-1 days', '100.00', agreeResIds)
  // Genuinely ahead of them.
  await makeBooking(agreeCustomer, 'confirmed', '2 days', '2 days 2 hours', '100.00', agreeResIds)
  // Happening right now — upcoming on both surfaces (max(ends_at) is future).
  await makeBooking(agreeCustomer, 'checked_in', '-1 hours', '1 hours', '100.00', agreeResIds)
  // Ordinary history.
  await makeBooking(agreeCustomer, 'completed', '-5 days', '-5 days 2 hours', '100.00', agreeResIds)
  await makeBooking(agreeCustomer, 'cancelled', '3 days', '3 days 1 hours', '100.00', agreeResIds)

  const agreeLists = await withCustomer(agreeCustomer, (tx) => readPortalBookings(tx, tenantId))
  const agreeSummary = await withCustomer(agreeCustomer, (tx) =>
    readPortalSummary(tx, { id: agreeCustomer, tenantId, name: 'Agree', phone: '+919000000901', email: null }),
  )

  check(
    'the overview upcoming count equals the Upcoming list length',
    agreeSummary.upcomingBookings === agreeLists.upcoming.length,
  )
  check('…which is 2 here, not 3', agreeSummary.upcomingBookings === 2)
  check(
    'a CONFIRMED booking that already finished is NOT counted upcoming',
    agreeLists.upcoming.every((b) => b.endsAt === null || b.endsAt.getTime() > Date.now()),
  )
  check(
    '…and it really is in the Past list',
    agreeLists.past.some((b) => b.status === 'confirmed'),
  )
  check(
    'the overview total equals upcoming + past',
    agreeSummary.totalBookings === agreeLists.upcoming.length + agreeLists.past.length,
  )

  // A booking with no slots at all: the list gives it a defined answer via
  // coalesce(..., created_at), and the count must use the same fallback.
  await makeBooking(agreeCustomer, 'confirmed', null, null)
  const slotlessLists = await withCustomer(agreeCustomer, (tx) => readPortalBookings(tx, tenantId))
  const slotlessSummary = await withCustomer(agreeCustomer, (tx) =>
    readPortalSummary(tx, { id: agreeCustomer, tenantId, name: 'Agree', phone: '+919000000901', email: null }),
  )
  check(
    'a slotless booking is classified identically by both',
    slotlessSummary.upcomingBookings === slotlessLists.upcoming.length,
  )
  check(
    '…and still counted in the total',
    slotlessSummary.totalBookings === slotlessLists.upcoming.length + slotlessLists.past.length,
  )

  await wipe()
  await owner.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
