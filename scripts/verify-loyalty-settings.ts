/**
 * Loyalty settings: authorization, tenant isolation, defaults, and the POS
 * consuming them.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-loyalty-settings.ts
 *
 * The settings page is manager-only and the till reads the same row on every
 * bill, so this covers both halves: who may change the rule, and that changing
 * it actually moves earning, redemption, the minimum and the on/off switch.
 *
 * The server action itself needs a request context (requireManager reads
 * cookies), so what is exercised here is the reader, the RLS policies as the
 * restricted role, and the POS functions — i.e. everything the action composes.
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let passed = 0
let failed = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else failed++
}

async function main() {
  const {
    loadLoyaltyRule,
    DEFAULT_LOYALTY_RULE,
    pointsForSpend,
    discountForPoints,
    loyaltyTenderState,
  } = await import('../lib/billing/loyalty')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1,$2,'active')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    const mk = async (email: string, role: string) => {
      const u = await owner.query<{ id: string }>(
        `insert into users (email, password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await owner.query(
        `insert into memberships (tenant_id, user_id, role, status)
         values ($1,$2,$3::member_role,'active')
         on conflict (tenant_id, user_id) do update set role=excluded.role, status='active'`,
        [t.rows[0].id, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      tenantId: t.rows[0].id,
      ownerId: await mk(`owner@${slug}.test`, 'owner'),
      managerId: await mk(`manager@${slug}.test`, 'manager'),
      cashierId: await mk(`cashier@${slug}.test`, 'cashier'),
    }
  }

  const tA = await makeTenant('lsetta')
  const tB = await makeTenant('lsettb')
  await owner.query('delete from loyalty_settings where tenant_id = any($1)', [
    [tA.tenantId, tB.tenantId],
  ])

  async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  /** The exact upsert lib/actions/loyalty.ts performs, as the given user. */
  async function saveAs(userId: string, tenantId: string, v: Record<string, unknown>) {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return tx.execute(sql`
        insert into public.loyalty_settings
          (tenant_id, points_per_unit, unit_amount, point_value, min_redeem_points, is_active)
        values (${tenantId}::uuid, ${v.pointsPerUnit}, ${v.unitAmount}, ${v.pointValue},
                ${v.minRedeemPoints}, ${v.isActive})
        on conflict (tenant_id) do update set
          points_per_unit = excluded.points_per_unit,
          unit_amount = excluded.unit_amount,
          point_value = excluded.point_value,
          min_redeem_points = excluded.min_redeem_points,
          is_active = excluded.is_active
      `)
    })
  }

  // ══ 1. defaults with no row ════════════════════════════════════════════════
  console.log('\n── defaults (no row) ──')

  const noRow = await owner.query('select 1 from loyalty_settings where tenant_id=$1', [tA.tenantId])
  check('tenant A genuinely has no settings row', noRow.rowCount === 0)

  const defaults = await asUser(tA.managerId, (tx) => loadLoyaltyRule(tx, tA.tenantId))
  check('the reader returns the shipped defaults', defaults.pointsPerUnit === DEFAULT_LOYALTY_RULE.pointsPerUnit)
  check('…unit amount 100', defaults.unitAmount === 100)
  check('…point value 1', defaults.pointValue === 1)
  check('…min redeem 0', defaults.minRedeemPoints === 0)
  check('…and the programme is active by default', defaults.isActive === true)

  check('POS earns on the defaults: ₹1000 → 10 points', pointsForSpend(1000, defaults) === 10)
  check('…and ₹999 → 9 (floored, never rounded up)', pointsForSpend(999, defaults) === 9)

  // ══ 2. manager and owner can write ═════════════════════════════════════════
  console.log('\n── authorization ──')

  const mgr = await saveAs(tA.managerId, tA.tenantId, {
    pointsPerUnit: 5,
    unitAmount: '50.00',
    pointValue: '2.00',
    minRedeemPoints: 100,
    isActive: true,
  })
  check('a MANAGER can save settings', (mgr.rowCount ?? 0) === 1)
  check('…creating the row for a tenant that had none',
    (await owner.query('select 1 from loyalty_settings where tenant_id=$1', [tA.tenantId])).rowCount === 1)

  const own = await saveAs(tA.ownerId, tA.tenantId, {
    pointsPerUnit: 4,
    unitAmount: '50.00',
    pointValue: '2.00',
    minRedeemPoints: 100,
    isActive: true,
  })
  check('an OWNER can save settings', (own.rowCount ?? 0) === 1)

  let cashierBlocked = false
  try {
    const r = await saveAs(tA.cashierId, tA.tenantId, {
      pointsPerUnit: 999,
      unitAmount: '1.00',
      pointValue: '999.00',
      minRedeemPoints: 0,
      isActive: true,
    })
    cashierBlocked = (r.rowCount ?? 0) === 0
  } catch {
    cashierBlocked = true // RLS with-check violation
  }
  check('a CASHIER cannot save settings (RLS)', cashierBlocked)

  const afterCashier = await owner.query<{ points_per_unit: number }>(
    'select points_per_unit from loyalty_settings where tenant_id=$1',
    [tA.tenantId],
  )
  check('…and the settings are unchanged', afterCashier.rows[0].points_per_unit === 4)

  const cashierRead = await asUser(tA.cashierId, (tx) => loadLoyaltyRule(tx, tA.tenantId))
  check('a cashier CAN read the rule (the till needs it)', cashierRead.pointsPerUnit === 4)

  // ══ 3. tenant isolation ════════════════════════════════════════════════════
  console.log('\n── tenant isolation ──')

  await saveAs(tB.managerId, tB.tenantId, {
    pointsPerUnit: 77,
    unitAmount: '10.00',
    pointValue: '3.00',
    minRedeemPoints: 7,
    isActive: false,
  })

  const crossRead = await asUser(tA.managerId, async (tx) => {
    const r = await tx.execute<{ n: string }>(
      sql`select count(*)::text n from public.loyalty_settings where tenant_id = ${tB.tenantId}::uuid`,
    )
    return Number(r.rows[0].n)
  })
  check("tenant A CANNOT read tenant B's settings", crossRead === 0)

  // loadLoyaltyRule for another tenant must fall back to defaults, never leak.
  const crossRule = await asUser(tA.managerId, (tx) => loadLoyaltyRule(tx, tB.tenantId))
  check("…and asking for B's rule yields defaults, not B's 77", crossRule.pointsPerUnit === 1)

  let crossWrite = false
  try {
    const r = await saveAs(tA.managerId, tB.tenantId, {
      pointsPerUnit: 1,
      unitAmount: '1.00',
      pointValue: '1.00',
      minRedeemPoints: 0,
      isActive: true,
    })
    crossWrite = (r.rowCount ?? 0) === 0
  } catch {
    crossWrite = true
  }
  check("tenant A CANNOT write tenant B's settings", crossWrite)

  const bIntact = await owner.query<{ points_per_unit: number }>(
    'select points_per_unit from loyalty_settings where tenant_id=$1',
    [tB.tenantId],
  )
  check("…and B's settings are untouched", bIntact.rows[0].points_per_unit === 77)

  // ══ 4. the database rejects invalid values ═════════════════════════════════
  console.log('\n── invalid values ──')

  const INVALID: Array<[string, Record<string, unknown>]> = [
    ['negative points_per_unit', { pointsPerUnit: -1, unitAmount: '50.00', pointValue: '2.00', minRedeemPoints: 0, isActive: true }],
    ['zero points_per_unit', { pointsPerUnit: 0, unitAmount: '50.00', pointValue: '2.00', minRedeemPoints: 0, isActive: true }],
    ['negative unit_amount', { pointsPerUnit: 1, unitAmount: '-50.00', pointValue: '2.00', minRedeemPoints: 0, isActive: true }],
    ['zero unit_amount', { pointsPerUnit: 1, unitAmount: '0.00', pointValue: '2.00', minRedeemPoints: 0, isActive: true }],
    ['negative point_value', { pointsPerUnit: 1, unitAmount: '50.00', pointValue: '-2.00', minRedeemPoints: 0, isActive: true }],
    ['negative min_redeem_points', { pointsPerUnit: 1, unitAmount: '50.00', pointValue: '2.00', minRedeemPoints: -5, isActive: true }],
  ]
  for (const [label, values] of INVALID) {
    let rejected = false
    try {
      await saveAs(tA.managerId, tA.tenantId, values)
    } catch {
      rejected = true
    }
    check(`the database rejects ${label}`, rejected)
  }

  const stillFour = await owner.query<{ points_per_unit: number }>(
    'select points_per_unit from loyalty_settings where tenant_id=$1',
    [tA.tenantId],
  )
  check('…and none of them changed the stored settings', stillFour.rows[0].points_per_unit === 4)

  // ══ 5. POS consumes the saved settings ═════════════════════════════════════
  console.log('\n── POS integration ──')

  await saveAs(tA.managerId, tA.tenantId, {
    pointsPerUnit: 5,
    unitAmount: '50.00',
    pointValue: '2.00',
    minRedeemPoints: 100,
    isActive: true,
  })
  const custom = await asUser(tA.managerId, (tx) => loadLoyaltyRule(tx, tA.tenantId))

  check('EARNING follows the new rule: ₹500 → 50 points', pointsForSpend(500, custom) === 50)
  check('…and is floored per whole unit: ₹549 → 50', pointsForSpend(549, custom) === 50)
  check('…₹550 → 55', pointsForSpend(550, custom) === 55)
  check('REDEEM VALUE follows point_value: 10 points → ₹20', discountForPoints(10, custom) === 20)
  check('MINIMUM is carried through', custom.minRedeemPoints === 100)

  // Prove it CHANGED — the defaults would have produced different numbers.
  check('…and these differ from the defaults (the setting really took effect)',
    pointsForSpend(500, DEFAULT_LOYALTY_RULE) === 5 && pointsForSpend(500, custom) === 50)

  // is_active = false must switch the whole thing off.
  const cust = await owner.query<{ id: string }>(
    `insert into customers (tenant_id, phone, name) values ($1,'+919000006001','LS')
     on conflict (tenant_id, phone) do update set name='LS' returning id`,
    [tA.tenantId],
  )
  const activeState = await asUser(tA.managerId, (tx) =>
    loyaltyTenderState(tx, tA.tenantId, cust.rows[0].id),
  )
  check('while active, the till offers loyalty tender', activeState !== null)

  await saveAs(tA.managerId, tA.tenantId, {
    pointsPerUnit: 5,
    unitAmount: '50.00',
    pointValue: '2.00',
    minRedeemPoints: 100,
    isActive: false,
  })
  const offRule = await asUser(tA.managerId, (tx) => loadLoyaltyRule(tx, tA.tenantId))
  check('is_active=false is read back', offRule.isActive === false)
  check('…EARNING stops (₹500 → 0 points)', pointsForSpend(500, offRule) === 0)

  const offState = await asUser(tA.managerId, (tx) =>
    loyaltyTenderState(tx, tA.tenantId, cust.rows[0].id),
  )
  check('…and the till stops offering loyalty tender entirely', offState === null)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await appPool.end()
  await owner.query('delete from customers where tenant_id = any($1)', [[tA.tenantId, tB.tenantId]])
  await owner.query('delete from loyalty_settings where tenant_id = any($1)', [
    [tA.tenantId, tB.tenantId],
  ])
  await owner.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
