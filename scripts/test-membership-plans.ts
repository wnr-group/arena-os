/**
 * Membership plan MANAGEMENT — integration tests against a real database.
 *
 * Covers what the settings UI does, at the RLS layer the actions write through:
 *   - create / edit / deactivate / reactivate
 *   - money and benefits stored as numeric(10,2), read back as exact strings
 *   - the DB check constraints the Zod schema mirrors
 *   - one LIVE plan per name per tenant, case-insensitively
 *   - editing never resets a field the manager did not change
 *   - managers may write, cashiers may not, tenants stay isolated
 *
 *   npx tsx scripts/test-membership-plans.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { membershipPlans } from '../db/schema'
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

type PlanValues = {
  name: string
  price: string
  durationMonths: number
  discountPercent: string
  freeHours: string
  walletCredit: string
  isActive: boolean
}

/** The Gold plan from the ticket. */
const GOLD: PlanValues = {
  name: 'Gold',
  price: '2000.00',
  durationMonths: 1,
  discountPercent: '10.00',
  freeHours: '2.00',
  walletCredit: '500.00',
  isActive: true,
}

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

  /** Drizzle wraps driver errors; the SQLSTATE lives on `cause`. */
  function pgCode(e: unknown): string | undefined {
    let cur: unknown = e
    for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
      const o = cur as { code?: unknown; cause?: unknown }
      if (typeof o.code === 'string') return o.code
      cur = o.cause
    }
  }

  /** Mirrors what createMembershipPlan() writes, so RLS is exercised identically. */
  async function createAs(userId: string, tenantId: string, o: Partial<PlanValues> = {}) {
    try {
      const r = await withUser(userId, (tx) =>
        tx
          .insert(membershipPlans)
          .values({ tenantId, ...GOLD, ...o })
          .returning({ id: membershipPlans.id }),
      )
      return { ok: true as const, id: r[0].id, code: undefined as string | undefined }
    } catch (e) {
      return { ok: false as const, id: '', code: pgCode(e) }
    }
  }

  /** Mirrors updateMembershipPlan()'s UPDATE set. */
  async function editAs(userId: string, tenantId: string, id: string, values: Record<string, unknown>) {
    try {
      const r = await withUser(userId, (tx) =>
        tx
          .update(membershipPlans)
          .set(values)
          .where(and(eq(membershipPlans.id, id), eq(membershipPlans.tenantId, tenantId)))
          .returning({ id: membershipPlans.id }),
      )
      return { ok: true as const, rowCount: r.length }
    } catch (e) {
      return { ok: false as const, rowCount: 0, code: pgCode(e) }
    }
  }

  const rowOf = async (id: string) =>
    (await ownerPool.query('select * from membership_plans where id=$1', [id])).rows[0]

  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const mkUser = async (role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      tenantId,
      owner: await mkUser('owner'),
      manager: await mkUser('manager'),
      cashier: await mkUser('cashier'),
    }
  }

  const A = await makeTenant('testmpa')
  const B = await makeTenant('testmpb')
  for (const t of [A, B]) await ownerPool.query('delete from membership_plans where tenant_id=$1', [t.tenantId])

  // ── 1. the table shape the ticket specifies ───────────────────────────────
  {
    const cols = await ownerPool.query<{
      column_name: string
      data_type: string
      numeric_precision: number | null
      numeric_scale: number | null
      is_nullable: string
    }>(
      `select column_name, data_type, numeric_precision, numeric_scale, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='membership_plans'`,
    )
    const by = new Map(cols.rows.map((c) => [c.column_name, c]))
    const numeric = (name: string, p: number, s: number) => {
      const c = by.get(name)
      return !!c && c.data_type === 'numeric' && c.numeric_precision === p && c.numeric_scale === s
    }
    check('every required column exists', ['id', 'tenant_id', 'name', 'price', 'duration_months', 'discount_percent', 'free_hours', 'wallet_credit', 'is_active', 'created_at', 'updated_at'].every((c) => by.has(c)))
    check('tenant_id is NOT NULL', by.get('tenant_id')?.is_nullable === 'NO')
    check('price is numeric(10,2)', numeric('price', 10, 2))
    check('wallet_credit is numeric(10,2)', numeric('wallet_credit', 10, 2))
    check('free_hours is numeric(10,2)', numeric('free_hours', 10, 2))
    check('discount_percent is numeric(5,2)', numeric('discount_percent', 5, 2))
    check('duration_months is an integer', by.get('duration_months')?.data_type === 'integer')

    const fk = await ownerPool.query(
      `select 1 from pg_constraint
        where conrelid='public.membership_plans'::regclass and contype='f'
          and confrelid='public.tenants'::regclass`,
    )
    check('the tenant FK exists', fk.rowCount === 1)

    const rls = await ownerPool.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid='public.membership_plans'::regclass`,
    )
    check('RLS is enabled', rls.rows[0].relrowsecurity === true)

    const pol = await ownerPool.query<{ policyname: string; cmd: string; qual: string }>(
      `select policyname, cmd, qual from pg_policies
        where schemaname='public' and tablename='membership_plans'`,
    )
    const sel = pol.rows.find((p) => p.policyname === 'membership_plans_select')
    const wr = pol.rows.find((p) => p.policyname === 'membership_plans_write')
    check('a select policy exists, scoped by auth_tenant_ids()', !!sel && /auth_tenant_ids/.test(sel.qual))
    check('a manager write policy exists, gated by auth_is_manager()', !!wr && wr.cmd === 'ALL' && /auth_is_manager/.test(wr.qual))
    check('neither policy is a blanket `using (true)`', pol.rows.every((p) => p.qual?.trim() !== 'true'))

    const grants = await ownerPool.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name='membership_plans' and grantee='arena_app'`,
    )
    const held = new Set(grants.rows.map((g) => g.privilege_type))
    check('arena_app holds select/insert/update/delete', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => held.has(p)))

    const trg = await ownerPool.query(
      `select 1 from pg_trigger
        where tgrelid='public.membership_plans'::regclass and tgname='trg_membership_plans_updated'`,
    )
    check('the set_updated_at trigger is attached', trg.rowCount === 1)
  }

  // ── 2. create the ticket's Gold plan ──────────────────────────────────────
  {
    const r = await createAs(A.manager, A.tenantId)
    check('a MANAGER can create a plan', r.ok)
    if (r.ok) {
      const row = await rowOf(r.id)
      check('…Gold, ₹2000, 1 month is stored exactly', row.name === 'Gold' && row.price === '2000.00' && row.duration_months === 1)
      check('…10% discount, 2 free hours, ₹500 wallet credit are stored as separate columns', row.discount_percent === '10.00' && row.free_hours === '2.00' && row.wallet_credit === '500.00')
      check('…with the right tenant, active by default', row.tenant_id === A.tenantId && row.is_active === true)
    }
    const asOwner = await createAs(A.owner, A.tenantId, { name: 'Owner Silver' })
    check('an OWNER can create one too', asOwner.ok)
    check('isManager covers owner + manager, not cashier', isManager('owner') && isManager('manager') && !isManager('cashier'))
  }

  // ── 3. one LIVE plan per name, case-insensitively ─────────────────────────
  {
    for (const variant of ['Gold', 'gold', ' GOLD ']) {
      const dupe = await createAs(A.manager, A.tenantId, { name: variant })
      check(`a duplicate live '${variant}' is REJECTED with 23505`, !dupe.ok && dupe.code === '23505')
    }
    const other = await createAs(B.manager, B.tenantId)
    check('the SAME name in another tenant IS allowed', other.ok)

    // Retiring Gold must free the name for a relaunch — that is why the unique
    // index is partial on is_active rather than a plain unique(tenant_id,name).
    const gold = (await ownerPool.query(`select id from membership_plans where tenant_id=$1 and name='Gold'`, [A.tenantId])).rows[0]
    await editAs(A.manager, A.tenantId, gold.id, { isActive: false })
    const relaunch = await createAs(A.manager, A.tenantId, { name: 'Gold', price: '2500.00' })
    check('after deactivating Gold, a NEW Gold can be launched', relaunch.ok)
    await editAs(A.manager, A.tenantId, relaunch.id, { isActive: false })
    await ownerPool.query(`delete from membership_plans where tenant_id=$1 and name='Gold'`, [A.tenantId])
  }

  // ── 4. edit — and nothing unrelated may move ──────────────────────────────
  {
    const r = await createAs(A.manager, A.tenantId, { name: 'EditMe' })
    if (!r.ok) throw new Error('fixture failed')
    const before = await rowOf(r.id)

    // The action always writes the FULL editable shape, so an untouched field
    // is rewritten with its current value rather than nulled.
    const edited = await editAs(A.manager, A.tenantId, r.id, {
      name: 'EditMe',
      price: '2500.00',
      durationMonths: before.duration_months,
      discountPercent: before.discount_percent,
      freeHours: before.free_hours,
      walletCredit: before.wallet_credit,
      isActive: true,
    })
    check('a manager can edit a plan', edited.ok && edited.rowCount === 1)
    const row = await rowOf(r.id)
    check('…₹2000 → ₹2500 is applied', row.price === '2500.00')
    check('…the benefits are untouched by the price change', row.discount_percent === '10.00' && row.free_hours === '2.00' && row.wallet_credit === '500.00')
    check('…duration is untouched', row.duration_months === before.duration_months)
    check('…tenant_id and created_at cannot move', row.tenant_id === A.tenantId && +new Date(row.created_at) === +new Date(before.created_at))
    check('…updated_at moved past created_at (trigger)', new Date(row.updated_at) > new Date(row.created_at))

    // The edit must touch ONE plan and no other.
    const sibling = await createAs(A.manager, A.tenantId, { name: 'Bystander', price: '900.00' })
    if (!sibling.ok) throw new Error('fixture failed')
    await editAs(A.manager, A.tenantId, r.id, { price: '2600.00' })
    check('…and only the intended plan changed', (await rowOf(sibling.id)).price === '900.00')
  }

  // ── 5. deactivate / reactivate — never delete ─────────────────────────────
  {
    const r = await createAs(A.manager, A.tenantId, { name: 'Retire Me' })
    if (!r.ok) throw new Error('fixture failed')

    const off = await editAs(A.manager, A.tenantId, r.id, { isActive: false })
    check('a manager can deactivate a plan', off.ok && off.rowCount === 1)
    const row = await rowOf(r.id)
    check('…is_active is false and the row still EXISTS (history preserved)', row?.is_active === false)
    check('…the price and benefits survive deactivation', row.price === '2000.00' && row.wallet_credit === '500.00')

    const on = await editAs(A.manager, A.tenantId, r.id, { isActive: true })
    check('re-activating works', on.ok && (await rowOf(r.id)).is_active === true)
    await editAs(A.manager, A.tenantId, r.id, { isActive: false })
  }

  // ── 6. DB constraints the UI and Zod mirror ───────────────────────────────
  {
    const bad: [string, Partial<PlanValues>][] = [
      ['a negative price', { name: 'Bad1', price: '-1.00' }],
      ['negative free hours', { name: 'Bad2', freeHours: '-1.00' }],
      ['negative wallet credit', { name: 'Bad3', walletCredit: '-1.00' }],
      ['a discount above 100', { name: 'Bad4', discountPercent: '101.00' }],
      ['a negative discount', { name: 'Bad5', discountPercent: '-1.00' }],
      ['a zero duration', { name: 'Bad6', durationMonths: 0 }],
      ['a negative duration', { name: 'Bad7', durationMonths: -1 }],
      ['a blank name', { name: '   ' }],
    ]
    for (const [label, values] of bad) {
      const r = await createAs(A.manager, A.tenantId, values)
      check(`the DB rejects ${label}`, !r.ok)
    }
  }

  // ── 7. authorization at the DATABASE layer ────────────────────────────────
  {
    const cashierCreate = await createAs(A.cashier, A.tenantId, { name: 'Cashier Made' })
    check('a CASHIER cannot create a plan (membership_plans_write RLS)', !cashierCreate.ok)

    const target = await createAs(A.manager, A.tenantId, { name: 'RLS Target', price: '5.00' })
    if (!target.ok) throw new Error('fixture failed')
    // RLS refuses UPDATE by hiding the row, so this commits touching 0 rows.
    const cashierEdit = await editAs(A.cashier, A.tenantId, target.id, { price: '999.00' })
    check("a cashier's edit touches 0 rows", cashierEdit.rowCount === 0)
    check('…and the plan is genuinely unchanged', (await rowOf(target.id)).price === '5.00')

    const cashierDeactivate = await editAs(A.cashier, A.tenantId, target.id, { isActive: false })
    check("a cashier's deactivate touches 0 rows", cashierDeactivate.rowCount === 0)
    check('…and it is still active', (await rowOf(target.id)).is_active === true)

    const cashierDelete = await withUser(A.cashier, (tx) =>
      tx.delete(membershipPlans).where(eq(membershipPlans.id, target.id)).returning({ id: membershipPlans.id }),
    )
    check("a cashier's delete touches 0 rows", cashierDelete.length === 0)

    const cashierRead = await withUser(A.cashier, (tx) =>
      tx.select().from(membershipPlans).where(eq(membershipPlans.tenantId, A.tenantId)),
    )
    check('a cashier CAN read plans (the till prices one at the counter)', cashierRead.length > 0)
  }

  // ── 8. tenant isolation ───────────────────────────────────────────────────
  {
    const aRows = await withUser(A.manager, (tx) => tx.select().from(membershipPlans))
    check("tenant A's manager sees only tenant A plans", aRows.length > 0 && aRows.every((r) => r.tenantId === A.tenantId))

    const bRows = await withUser(B.manager, (tx) => tx.select().from(membershipPlans))
    check("tenant B's manager sees only tenant B plans", bRows.every((r) => r.tenantId === B.tenantId))
    check("…and none of tenant A's rows", !bRows.some((r) => aRows.some((a) => a.id === r.id)))

    const aTarget = aRows[0]
    const crossEdit = await editAs(B.manager, B.tenantId, aTarget.id, { price: '999.00' })
    check("tenant B cannot edit tenant A's plan (0 rows)", crossEdit.rowCount === 0)
    const crossSpoof = await editAs(B.manager, A.tenantId, aTarget.id, { price: '999.00' })
    check("…nor by passing tenant A's tenant id", crossSpoof.rowCount === 0)
    check("…and tenant A's plan is untouched", (await rowOf(aTarget.id)).price === aTarget.price)

    const crossDeactivate = await editAs(B.manager, A.tenantId, aTarget.id, { isActive: false })
    check("tenant B cannot deactivate tenant A's plan", crossDeactivate.rowCount === 0)

    const crossDelete = await withUser(B.manager, (tx) =>
      tx.delete(membershipPlans).where(eq(membershipPlans.id, aTarget.id)).returning({ id: membershipPlans.id }),
    )
    check("tenant B cannot delete tenant A's plan", crossDelete.length === 0)

    const crossCreate = await createAs(B.manager, A.tenantId, { name: 'Cross Made' })
    check('tenant B cannot create INTO tenant A', !crossCreate.ok)
  }

  // ── 9. what AROS-60/61 will read ──────────────────────────────────────────
  {
    const [plan] = await withUser(A.manager, (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(and(eq(membershipPlans.tenantId, A.tenantId), eq(membershipPlans.isActive, true)))
        .limit(1),
    )
    check('an active plan exposes price/duration/discount/free hours/wallet credit directly', !!plan && typeof plan.price === 'string' && typeof plan.durationMonths === 'number' && typeof plan.discountPercent === 'string' && typeof plan.freeHours === 'string' && typeof plan.walletCredit === 'string')
    check('…with no JSON or display string to parse', !!plan && !Object.values(plan).some((v) => typeof v === 'object' && v !== null && !(v instanceof Date)))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testmp%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
