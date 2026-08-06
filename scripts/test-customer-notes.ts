/**
 * Customer notes & tags — integration tests.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, desc, eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { customerNotes, customers, memberships } from '../db/schema'
import { findOrCreateCustomer, setCustomerTags, CustomerError } from '../lib/customers/service'
import { createNote, updateNote, deleteNote } from '../lib/customers/notes'
import { normalizeTags, hasTag, MAX_TAGS } from '../lib/customers/tags'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withUser — RLS-scoped transaction. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures (owner connection, bypasses RLS) ─────────────────────────────
  async function makeTenant(slug: string, email: string, fullName: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set name = excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1, 'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id, user_id, role, status, full_name, email)
       values ($1, $2, 'owner', 'active', $3, $4)
       on conflict (tenant_id, user_id)
         do update set role = 'owner', status = 'active', full_name = excluded.full_name
       returning id`,
      [t.rows[0].id, u.rows[0].id, fullName, email],
    )
    return {
      tenantId: t.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      fullName,
    }
  }

  const a = await makeTenant('notesa', 'owner@notesa.test', 'Asha Iyer')
  const b = await makeTenant('notesb', 'owner@notesb.test', 'Bala Rao')

  await ownerPool.query('delete from customers where tenant_id = any($1)', [[a.tenantId, b.tenantId]])

  const custA = await withUser(a.userId, (tx) =>
    findOrCreateCustomer(tx, a.tenantId, { phone: '9876500011', name: 'Tenant A customer' }),
  )
  const custB = await withUser(b.userId, (tx) =>
    findOrCreateCustomer(tx, b.tenantId, { phone: '9876500022', name: 'Tenant B customer' }),
  )

  /** Read a customer's notes the way the profile does (newest first, + author). */
  const readNotes = (userId: string, tenantId: string, customerId: string) =>
    withUser(userId, (tx) =>
      tx
        .select({
          id: customerNotes.id,
          body: customerNotes.body,
          createdAt: customerNotes.createdAt,
          updatedAt: customerNotes.updatedAt,
          author: memberships.fullName,
        })
        .from(customerNotes)
        .leftJoin(memberships, eq(memberships.id, customerNotes.createdBy))
        .where(
          and(eq(customerNotes.tenantId, tenantId), eq(customerNotes.customerId, customerId)),
        )
        .orderBy(desc(customerNotes.createdAt)),
    )

  const readTags = async (userId: string, tenantId: string, customerId: string) => {
    const [row] = await withUser(userId, (tx) =>
      tx
        .select({ tags: customers.tags })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
        .limit(1),
    )
    return row?.tags ?? null
  }

  // ══ 1. add a customer note ════════════════════════════════════════════════
  const before = Date.now()
  const note = await withUser(a.userId, (tx) =>
    createNote(tx, a.tenantId, {
      customerId: custA.id,
      body: '  Prefers the corner booth.  ',
      createdBy: a.membershipId,
    }),
  )
  check('a note can be added to a customer', Boolean(note.id))
  check('the note body is trimmed before storing', note.body === 'Prefers the corner booth.')
  check('the note is attached to the right customer', note.customerId === custA.id)
  check('the note carries the tenant', note.tenantId === a.tenantId)

  let emptyRejected = false
  try {
    await withUser(a.userId, (tx) =>
      createNote(tx, a.tenantId, { customerId: custA.id, body: '   ', createdBy: a.membershipId }),
    )
  } catch (e) {
    emptyRejected = e instanceof CustomerError
  }
  check('an empty note is REJECTED', emptyRejected)

  let missingCustomer = false
  try {
    await withUser(a.userId, (tx) =>
      createNote(tx, a.tenantId, {
        customerId: '00000000-0000-4000-8000-000000000000',
        body: 'ghost',
        createdBy: a.membershipId,
      }),
    )
  } catch (e) {
    missingCustomer = e instanceof CustomerError
  }
  check('a note against an unknown customer is REJECTED', missingCustomer)

  // ══ 5 & 6. author and timestamp ═══════════════════════════════════════════
  const stored = await readNotes(a.userId, a.tenantId, custA.id)
  check('exactly one note is on file', stored.length === 1)
  check('the note shows the author who wrote it', stored[0]?.author === a.fullName)
  check(
    'the note carries a created timestamp from around now',
    Math.abs((stored[0]?.createdAt.getTime() ?? 0) - before) < 60_000,
  )
  check(
    'a fresh note is not marked as edited (updated_at == created_at)',
    stored[0]?.updatedAt.getTime() === stored[0]?.createdAt.getTime(),
  )

  // ══ 2. edit a customer note ═══════════════════════════════════════════════
  const second = await withUser(a.userId, (tx) =>
    createNote(tx, a.tenantId, {
      customerId: custA.id,
      body: 'Allergic to peanuts.',
      createdBy: a.membershipId,
    }),
  )

  const edited = await withUser(a.userId, (tx) =>
    updateNote(tx, a.tenantId, note.id, 'Prefers the window seat.'),
  )
  check('a note can be edited', edited.body === 'Prefers the window seat.')
  check('editing preserves the original author', edited.createdBy === a.membershipId)
  check('editing preserves the original created timestamp', edited.createdAt.getTime() === note.createdAt.getTime())
  check('editing moves updated_at forward', edited.updatedAt.getTime() > edited.createdAt.getTime())

  const afterEdit = await readNotes(a.userId, a.tenantId, custA.id)
  check('editing one note leaves the other untouched', afterEdit.find((n) => n.id === second.id)?.body === 'Allergic to peanuts.')

  let emptyEdit = false
  try {
    await withUser(a.userId, (tx) => updateNote(tx, a.tenantId, note.id, '  '))
  } catch (e) {
    emptyEdit = e instanceof CustomerError
  }
  check('editing a note to empty is REJECTED', emptyEdit)

  // ══ 4. notes persist after a refresh (a brand-new connection/transaction) ══
  const reread = await readNotes(a.userId, a.tenantId, custA.id)
  check('notes survive into a new transaction — they are persisted, not cached', reread.length === 2)
  check('…with the edit applied', reread.find((n) => n.id === note.id)?.body === 'Prefers the window seat.')
  check(
    'notes come back newest first',
    reread[0]!.createdAt.getTime() >= reread[1]!.createdAt.getTime(),
  )

  // ══ 3. delete a customer note ═════════════════════════════════════════════
  const removed = await withUser(a.userId, (tx) => deleteNote(tx, a.tenantId, second.id))
  check('a note can be deleted', removed.id === second.id)
  check('deleting returns the customer the note belonged to', removed.customerId === custA.id)

  const afterDelete = await readNotes(a.userId, a.tenantId, custA.id)
  check('only the selected note is deleted', afterDelete.length === 1 && afterDelete[0]!.id === note.id)

  let deleteTwice = false
  try {
    await withUser(a.userId, (tx) => deleteNote(tx, a.tenantId, second.id))
  } catch (e) {
    deleteTwice = e instanceof CustomerError
  }
  check('deleting an already-deleted note is REJECTED, not silent', deleteTwice)

  // ══ 7. add a customer tag ═════════════════════════════════════════════════
  const tags1 = await withUser(a.userId, (tx) =>
    setCustomerTags(tx, a.tenantId, custA.id, ['VIP']),
  )
  check('a tag can be added', tags1.join() === 'VIP')

  const tags2 = await withUser(a.userId, (tx) =>
    setCustomerTags(tx, a.tenantId, custA.id, [...tags1, '  Regular  Player  ']),
  )
  check('a second tag can be added', tags2.length === 2)
  check('tags are trimmed and inner whitespace collapsed', tags2[1] === 'Regular Player')
  check('tags persist on the customer row', (await readTags(a.userId, a.tenantId, custA.id))?.join() === tags2.join())

  const tags3 = await withUser(a.userId, (tx) =>
    setCustomerTags(tx, a.tenantId, custA.id, [...tags2, '   ', '']),
  )
  check('empty tags are ignored', tags3.length === 2)

  // ══ 9. duplicate tags are prevented ═══════════════════════════════════════
  const dup = await withUser(a.userId, (tx) =>
    setCustomerTags(tx, a.tenantId, custA.id, [...tags3, 'VIP']),
  )
  check('an exact duplicate tag is dropped', dup.length === 2)

  const dupCase = await withUser(a.userId, (tx) =>
    setCustomerTags(tx, a.tenantId, custA.id, [...tags3, 'vip', ' ViP ']),
  )
  check('a duplicate differing only in case is dropped', dupCase.length === 2)
  check('…and the first spelling is the one kept', dupCase[0] === 'VIP')
  check('normalizeTags collapses duplicates on its own', normalizeTags(['a', 'A', ' a ']).length === 1)
  check('hasTag matches case-insensitively', hasTag(['VIP'], 'vip') && !hasTag(['VIP'], 'vips'))
  check(
    `the tag list is capped at ${MAX_TAGS}`,
    normalizeTags(Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${i}`)).length === MAX_TAGS,
  )

  // ══ 8. remove a customer tag ══════════════════════════════════════════════
  const removedTag = await withUser(a.userId, (tx) =>
    setCustomerTags(tx, a.tenantId, custA.id, dupCase.filter((t) => t !== 'VIP')),
  )
  check('a tag can be removed', removedTag.join() === 'Regular Player')
  check('…and the removal is persisted', (await readTags(a.userId, a.tenantId, custA.id))?.join() === 'Regular Player')

  const cleared = await withUser(a.userId, (tx) => setCustomerTags(tx, a.tenantId, custA.id, []))
  check('the last tag can be removed, leaving an empty list', cleared.length === 0)
  await withUser(a.userId, (tx) => setCustomerTags(tx, a.tenantId, custA.id, ['VIP']))

  // ══ 10 & 11. tenant scoping ═══════════════════════════════════════════════
  await withUser(b.userId, (tx) =>
    createNote(tx, b.tenantId, {
      customerId: custB.id,
      body: 'Tenant B private note',
      createdBy: b.membershipId,
    }),
  )
  await withUser(b.userId, (tx) => setCustomerTags(tx, b.tenantId, custB.id, ['B-only']))

  const bSees = await withUser(b.userId, (tx) => tx.select().from(customerNotes))
  check(
    'a member sees ONLY their own tenant’s notes',
    bSees.length > 0 && bSees.every((n) => n.tenantId === b.tenantId),
  )
  check('tenant B cannot see tenant A’s note by customer', (await readNotes(b.userId, b.tenantId, custA.id)).length === 0)

  // Passing tenant A's own id but tenant B's customer: RLS still returns nothing.
  const bWithATenantId = await readNotes(b.userId, a.tenantId, custA.id)
  check('…not even when querying with tenant A’s tenant_id (RLS, not the predicate)', bWithATenantId.length === 0)

  check('tenant B cannot read tenant A’s tags', (await readTags(b.userId, a.tenantId, custA.id)) === null)

  let crossRead = false
  try {
    const r = await withUser(b.userId, (tx) =>
      tx.select().from(customerNotes).where(eq(customerNotes.id, note.id)),
    )
    crossRead = r.length > 0
  } catch {
    crossRead = false
  }
  check('tenant B cannot read tenant A’s note even by its id', !crossRead)

  // writes aimed at the other tenant
  let crossNote = false
  try {
    await withUser(b.userId, (tx) =>
      createNote(tx, a.tenantId, {
        customerId: custA.id,
        body: 'injected',
        createdBy: b.membershipId,
      }),
    )
    crossNote = true
  } catch {
    crossNote = false
  }
  check('tenant B CANNOT write a note into tenant A', !crossNote)

  // The dangerous shape: a note stamped with MY tenant but pointing at THEIR
  // customer. RLS's WITH CHECK passes (the tenant_id is mine) — the composite
  // FK from migration 0009 is what refuses it.
  let smuggled = false
  try {
    await withUser(b.userId, (tx) =>
      tx.execute(
        sql`insert into customer_notes (tenant_id, customer_id, body)
            values (${b.tenantId}, ${custA.id}, 'smuggled')`,
      ),
    )
    smuggled = true
  } catch {
    smuggled = false
  }
  check('a note in MY tenant cannot point at ANOTHER tenant’s customer (composite FK)', !smuggled)

  let crossEdit = false
  try {
    await withUser(b.userId, (tx) => updateNote(tx, b.tenantId, note.id, 'hacked'))
    crossEdit = true
  } catch {
    crossEdit = false
  }
  const stillMine = await readNotes(a.userId, a.tenantId, custA.id)
  check('tenant B CANNOT edit tenant A’s note', !crossEdit && stillMine[0]?.body !== 'hacked')

  let crossDelete = false
  try {
    await withUser(b.userId, (tx) => deleteNote(tx, b.tenantId, note.id))
    crossDelete = true
  } catch {
    crossDelete = false
  }
  check(
    'tenant B CANNOT delete tenant A’s note',
    !crossDelete && (await readNotes(a.userId, a.tenantId, custA.id)).length === 1,
  )

  let crossTags = false
  try {
    await withUser(b.userId, (tx) => setCustomerTags(tx, b.tenantId, custA.id, ['pwned']))
    crossTags = true
  } catch {
    crossTags = false
  }
  check(
    'tenant B CANNOT retag tenant A’s customer',
    !crossTags && (await readTags(a.userId, a.tenantId, custA.id))?.join() === 'VIP',
  )

  // ══ notes follow their customer out the door ══════════════════════════════
  await withUser(a.userId, (tx) =>
    tx.delete(customers).where(and(eq(customers.tenantId, a.tenantId), eq(customers.id, custA.id))),
  )
  const orphans = await ownerPool.query('select id from customer_notes where customer_id = $1', [custA.id])
  check('deleting a customer cascades their notes away', orphans.rows.length === 0)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[a.tenantId, b.tenantId]])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
