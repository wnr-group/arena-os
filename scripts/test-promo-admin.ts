/**
 * Promo code MANAGEMENT — integration tests against a real database.
 *
 * scripts/test-promo.ts already covers validatePromo/consumePromoUse and the
 * billing path. This one covers what the management UI does:
 *   - create / edit / expire, at the RLS layer the actions write through
 *   - case-insensitive uniqueness per tenant, and reuse across tenants
 *   - editing never touches `uses`
 *   - expiring makes the code unusable at billing immediately
 *   - managers may write, cashiers may not, tenants stay isolated
 *
 *   npx tsx scripts/test-promo-admin.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { promoCodes } from '../db/schema'
import { validatePromo } from '../lib/billing/promo'
import { isManager } from '../lib/auth/roles'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const DAY = 86_400_000

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  /** Mirrors what upsertPromoCode() writes, so RLS is exercised identically. */
  async function createAs(userId: string, tenantId: string, code: string, o: Partial<{ type: 'percentage' | 'fixed'; value: string; from: Date; until: Date; maxUses: number | null; active: boolean }> = {}) {
    const now = Date.now()
    const { type = 'percentage', value = '10.00', from = new Date(now - DAY), until = new Date(now + DAY), maxUses = null, active = true } = o
    try {
      const r = await withUser(userId, (tx) =>
        tx.insert(promoCodes).values({
          tenantId, code: code.trim().toUpperCase(), discountType: type, discountValue: value,
          validFrom: from, validUntil: until, maxUses, isActive: active,
        }).returning({ id: promoCodes.id }))
      return { ok: true as const, id: r[0].id, code: undefined as string | undefined }
    } catch (e) {
      return { ok: false as const, id: '', code: pgCode(e) }
    }
  }

  /** Drizzle wraps driver errors; the SQLSTATE lives on `cause`. */
  function pgCode(e: unknown): string | undefined {
    let cur: unknown = e
    for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
      const o = cur as { code?: unknown; cause?: unknown }
      if (typeof o.code === 'string') return o.code
      cur = o.cause
    }
  }

  /** Mirrors upsertPromoCode()'s UPDATE set — note `uses` is never in it. */
  async function editAs(userId: string, tenantId: string, id: string, values: Record<string, unknown>) {
    try {
      const r = await withUser(userId, (tx) =>
        tx.update(promoCodes).set(values).where(and(eq(promoCodes.id, id), eq(promoCodes.tenantId, tenantId))).returning({ id: promoCodes.id }))
      return { ok: true as const, rowCount: r.length }
    } catch (e) {
      return { ok: false as const, rowCount: 0, message: e instanceof Error ? e.message : String(e) }
    }
  }

  const rowOf = async (id: string) =>
    (await ownerPool.query('select * from promo_codes where id=$1', [id])).rows[0]

  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`])
    const tenantId = t.rows[0].id
    const mkUser = async (role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`, [`${role}@${slug}.test`])
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`, [tenantId, u.rows[0].id, role])
      return u.rows[0].id
    }
    return { tenantId, owner: await mkUser('owner'), manager: await mkUser('manager'), cashier: await mkUser('cashier') }
  }

  const A = await makeTenant('testpadma')
  const B = await makeTenant('testpadmb')
  for (const t of [A, B]) await ownerPool.query('delete from promo_codes where tenant_id=$1', [t.tenantId])

  // ── 1. create ─────────────────────────────────────────────────────────────
  {
    const r = await createAs(A.manager, A.tenantId, ' welcome10 ')
    check('a MANAGER can create a promo code', r.ok)
    if (r.ok) {
      const row = await rowOf(r.id)
      check('…the code is stored upper-cased and trimmed (WELCOME10)', row.code === 'WELCOME10')
      check('…with the right tenant, discount and defaults', row.tenant_id === A.tenantId && row.discount_type === 'percentage' && row.discount_value === '10.00')
      check('…uses starts at 0 and it is active', row.uses === 0 && row.is_active === true)
      check('…max_uses null means unlimited', row.max_uses === null)
    }
    const asOwner = await createAs(A.owner, A.tenantId, 'OWNERMADE')
    check('an OWNER can create one too', asOwner.ok)
    check('isManager covers owner + manager, not cashier', isManager('owner') && isManager('manager') && !isManager('cashier'))
  }

  // ── 2. uniqueness ─────────────────────────────────────────────────────────
  {
    const countOf = async (tenantId: string, code: string) =>
      Number((await ownerPool.query('select count(*)::int n from promo_codes where tenant_id=$1 and upper(code)=$2', [tenantId, code])).rows[0].n)

    for (const variant of ['welcome10', 'WELCOME10', 'Welcome10']) {
      const dupe = await createAs(A.manager, A.tenantId, variant)
      check(`a duplicate '${variant}' in the same tenant is REJECTED`, !dupe.ok)
      // The driver code, not the message: Drizzle wraps the pg error, so its
      // `.message` is only "Failed query: …" — which is exactly the trap the
      // action's fail() handler had to be fixed for.
      check(`…with SQLSTATE 23505 (unique_violation), not a text match`, !dupe.ok && dupe.code === '23505')
    }
    check('…and only ONE WELCOME10 row exists for the tenant', (await countOf(A.tenantId, 'WELCOME10')) === 1)

    const other = await createAs(B.manager, B.tenantId, 'WELCOME10')
    check('the SAME code in another tenant IS allowed', other.ok)
    check('…so each tenant has its own WELCOME10', (await countOf(B.tenantId, 'WELCOME10')) === 1)
  }

  // ── 3. edit — and `uses` must survive it ──────────────────────────────────
  {
    const r = await createAs(A.manager, A.tenantId, 'EDITME', { maxUses: 50 })
    if (!r.ok) throw new Error('fixture failed')
    // Billing is the only thing that ever writes `uses`; simulate 12 redemptions.
    await ownerPool.query('update promo_codes set uses=12 where id=$1', [r.id])

    const edited = await editAs(A.manager, A.tenantId, r.id, {
      discountType: 'fixed', discountValue: '75.00', maxUses: 100, isActive: true,
    })
    check('a manager can edit a promo code', edited.ok && edited.rowCount === 1)
    const row = await rowOf(r.id)
    check('…the discount type and value changed', row.discount_type === 'fixed' && row.discount_value === '75.00')
    check('…the usage limit moved 50 → 100', row.max_uses === 100)
    check('…and `uses` is STILL 12 — editing never resets it', row.uses === 12)
    check('…the code itself is unchanged (immutable after creation)', row.code === 'EDITME')
    check('…updated_at moved past created_at (trigger)', new Date(row.updated_at) > new Date(row.created_at))
  }

  // ── 4. expire, and what billing then does ─────────────────────────────────
  {
    const r = await createAs(A.manager, A.tenantId, 'EXPIREME')
    if (!r.ok) throw new Error('fixture failed')
    const before = await withUser(A.manager, (tx) => validatePromo(tx, A.tenantId, 'EXPIREME', 1000))
    check('before expiring, billing accepts the code', before.ok)

    const expired = await editAs(A.manager, A.tenantId, r.id, { isActive: false })
    check('a manager can expire it', expired.ok && expired.rowCount === 1)
    check('…the row is deactivated, NOT deleted (invoices still reference it)', (await rowOf(r.id))?.is_active === false)

    const after = await withUser(A.manager, (tx) => validatePromo(tx, A.tenantId, 'EXPIREME', 1000))
    check('…and billing rejects it immediately', !after.ok && after.reason === 'Promo code is inactive.')

    const reactivated = await editAs(A.manager, A.tenantId, r.id, { isActive: true })
    check('re-activating works', reactivated.ok)
    check('…and billing accepts it again', (await withUser(A.manager, (tx) => validatePromo(tx, A.tenantId, 'EXPIREME', 1000))).ok)
  }

  // ── 5. the other states billing must refuse ───────────────────────────────
  {
    const now = Date.now()
    const cases: [string, Parameters<typeof createAs>[3], string][] = [
      ['SCHEDULED', { from: new Date(now + DAY), until: new Date(now + 2 * DAY) }, 'Promo code is not active yet.'],
      ['LAPSED', { from: new Date(now - 2 * DAY), until: new Date(now - DAY) }, 'Promo code has expired.'],
      ['MAXED', { maxUses: 5 }, 'Promo code usage limit reached.'],
    ]
    for (const [code, opts, reason] of cases) {
      const r = await createAs(A.manager, A.tenantId, code, opts)
      if (!r.ok) throw new Error('fixture failed for ' + code)
      if (code === 'MAXED') await ownerPool.query('update promo_codes set uses=5 where id=$1', [r.id])
      const v = await withUser(A.manager, (tx) => validatePromo(tx, A.tenantId, code, 1000))
      check(`billing refuses a ${code.toLowerCase()} code → "${reason}"`, !v.ok && v.reason === reason)
    }
  }

  // ── 6. DB constraints the UI mirrors ──────────────────────────────────────
  {
    const badDates = await createAs(A.manager, A.tenantId, 'BADDATES', { from: new Date(Date.now() + DAY), until: new Date(Date.now() - DAY) })
    check('the DB rejects valid_until <= valid_from (promo_valid_dates)', !badDates.ok)
    const negative = await createAs(A.manager, A.tenantId, 'NEGATIVE', { value: '-5.00' })
    check('the DB rejects a negative discount_value', !negative.ok)
  }

  // ── 7. authorization at the DATABASE layer ────────────────────────────────
  {
    const cashierCreate = await createAs(A.cashier, A.tenantId, 'CASHIERMADE')
    check('a CASHIER cannot create a promo code (promo_write RLS)', !cashierCreate.ok)

    const target = await createAs(A.manager, A.tenantId, 'RLSTARGET', { value: '5.00' })
    if (!target.ok) throw new Error('fixture failed')
    // RLS refuses UPDATE by hiding the row, so this commits touching 0 rows.
    const cashierEdit = await editAs(A.cashier, A.tenantId, target.id, { discountValue: '999.00' })
    check("a cashier's edit touches 0 rows", cashierEdit.rowCount === 0)
    check('…and the promo is genuinely unchanged', (await rowOf(target.id)).discount_value === '5.00')
    const cashierExpire = await editAs(A.cashier, A.tenantId, target.id, { isActive: false })
    check("a cashier's expire touches 0 rows", cashierExpire.rowCount === 0)
    check('…and it is still active', (await rowOf(target.id)).is_active === true)

    const cashierRead = await withUser(A.cashier, (tx) =>
      tx.select().from(promoCodes).where(eq(promoCodes.tenantId, A.tenantId)))
    check('a cashier CAN read promos (the till resolves quoted codes)', cashierRead.length > 0)
  }

  // ── 8. tenant isolation ───────────────────────────────────────────────────
  {
    const aRows = await withUser(A.manager, (tx) => tx.select().from(promoCodes))
    check("tenant A's manager sees only tenant A codes", aRows.every((r) => r.tenantId === A.tenantId) && aRows.length > 0)

    const bRows = await withUser(B.manager, (tx) => tx.select().from(promoCodes))
    check("tenant B's manager sees only tenant B codes", bRows.every((r) => r.tenantId === B.tenantId))
    check("…and cannot see tenant A's WELCOME10 row", !bRows.some((r) => aRows.some((a) => a.id === r.id)))

    const aTarget = aRows[0]
    const crossEdit = await editAs(B.manager, B.tenantId, aTarget.id, { discountValue: '999.00' })
    check("tenant B cannot edit tenant A's promo (0 rows)", crossEdit.rowCount === 0)
    const crossEditSpoof = await editAs(B.manager, A.tenantId, aTarget.id, { discountValue: '999.00' })
    check("…nor by passing tenant A's tenant id", crossEditSpoof.rowCount === 0)
    check("…and tenant A's promo is untouched", (await rowOf(aTarget.id)).discount_value === aTarget.discountValue)

    const crossCreate = await createAs(B.manager, A.tenantId, 'CROSSMADE')
    check("tenant B cannot create INTO tenant A", !crossCreate.ok)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testpadm%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
