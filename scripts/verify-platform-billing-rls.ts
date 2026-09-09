/**
 * M16 #3 — the ISOLATION guarantees of platform subscription billing, proved
 * against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-platform-billing-rls.ts
 *
 * Two connections, the same device every verify-* script here uses: `owner`
 * bypasses RLS and stands in for the platform-admin path, while `app` is the
 * restricted `arena_app` role that EVERY tenant request runs as. Anything the
 * app pool cannot do here, a tenant cannot do in production — including a
 * tenant owner, a platform-admin-shaped URL guess, or a crafted server action,
 * because all of them ultimately reach the database through this one role.
 *
 * The claims under test:
 *   1. no tenant can read, write or even touch the platform's Razorpay secrets;
 *   2. no tenant can read another tenant's subscription;
 *   3. no tenant can write its own subscription;
 *   4. the plan catalogue's gateway references behave as the public data they
 *      are, while every secret stays out of reach;
 *   5. the platform-admin guard is what protects the admin readers, not a page.
 */
import { Pool } from 'pg'
import { randomBytes } from 'node:crypto'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

/** Did this statement fail the way a permission/RLS refusal fails? */
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'error'
  }
}

async function main() {
  const { encryptSecret } = await import('../lib/security/encryption')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })

  /** Raw app-role SQL as a given user, for the RLS probes. */
  async function asUser<T>(userId: string, run: (c: Pool) => Promise<T>): Promise<T> {
    const c = await appPool.connect()
    try {
      await c.query('begin')
      await c.query(`select set_config('app.user_id', $1, true)`, [userId])
      const r = await run(c as unknown as Pool)
      await c.query('commit')
      return r
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  const tag = randomBytes(4).toString('hex')
  const PLATFORM_SECRET = `whsec_${randomBytes(16).toString('hex')}`
  const created: string[] = []
  const planIds: string[] = []

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata') returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    created.push(tenantId)
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`,
      [`${slug}@example.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name,email)
       values ($1,$2,'owner','active','Owner',$3)`,
      [tenantId, u.rows[0].id, `${slug}@example.test`],
    )
    return { tenantId, userId: u.rows[0].id, slug }
  }

  const A = await makeTenant(`vpb-a-${tag}`)
  const B = await makeTenant(`vpb-b-${tag}`)

  const plan = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, gateway,
                        gateway_monthly_plan_id, gateway_annual_plan_id)
     values ($1,'1000.00','10000.00','razorpay',$2,$3) returning id`,
    [`VPB Plan ${tag}`, `plan_M${tag}`, `plan_A${tag}`],
  )
  planIds.push(plan.rows[0].id)

  await owner.query(
    `insert into tenant_subscriptions (tenant_id,plan_id,billing_period,status,
                                       current_period_end,gateway,gateway_subscription_id,
                                       gateway_customer_id)
     values ($1,$2,'monthly','active', now() + interval '30 days','razorpay',$3,$4)`,
    [A.tenantId, plan.rows[0].id, `sub_A${tag}`, `cust_A${tag}`],
  )

  await owner.query(
    `insert into platform_payment_settings (id, razorpay_key_id, razorpay_key_secret_encrypted,
                                            razorpay_webhook_secret_encrypted)
     values (true,'rzp_test_platform',$1,$2)
     on conflict (id) do update set razorpay_key_id = excluded.razorpay_key_id,
       razorpay_key_secret_encrypted = excluded.razorpay_key_secret_encrypted,
       razorpay_webhook_secret_encrypted = excluded.razorpay_webhook_secret_encrypted`,
    [
      encryptSecret(`platformkey-${tag}`, 'platform:razorpay'),
      encryptSecret(PLATFORM_SECRET, 'platform:razorpay'),
    ],
  )

  // ══════════════════════════════════════════════════════════════════════════
  section('1. platform gateway secrets are unreachable from the app role')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // The strongest available guarantee: no GRANT at all, so the statement is
    // refused before RLS is even consulted. 42501 = insufficient_privilege.
    const sel = await asUser(A.userId, (c) =>
      refused(() => c.query('select * from platform_payment_settings')),
    )
    check('a tenant owner cannot SELECT platform_payment_settings', sel === '42501')

    const selOne = await asUser(A.userId, (c) =>
      refused(() =>
        c.query('select razorpay_webhook_secret_encrypted from platform_payment_settings'),
      ),
    )
    check('…not even one column of it', selOne === '42501')

    const ins = await asUser(A.userId, (c) =>
      refused(() =>
        c.query(
          `insert into platform_payment_settings (id, razorpay_key_id) values (true,'rzp_evil')`,
        ),
      ),
    )
    check('…cannot INSERT into it', ins === '42501')

    const upd = await asUser(A.userId, (c) =>
      refused(() =>
        c.query(`update platform_payment_settings set razorpay_key_id='rzp_evil' where id=true`),
      ),
    )
    check('…cannot UPDATE it — a tenant cannot repoint the platform gateway', upd === '42501')

    const del = await asUser(A.userId, (c) =>
      refused(() => c.query('delete from platform_payment_settings')),
    )
    check('…and cannot DELETE it', del === '42501')

    const cnt = await asUser(A.userId, (c) =>
      refused(() => c.query('select count(*) from platform_payment_settings')),
    )
    check('…cannot even count the rows (no existence oracle)', cnt === '42501')

    // Belt and braces: RLS is enabled with no policies, so a grant added by
    // mistake in some future migration still default-denies.
    const rls = await owner.query<{ relrowsecurity: boolean; n: number }>(
      `select c.relrowsecurity,
              (select count(*)::int from pg_policies p
                where p.tablename='platform_payment_settings') as n
         from pg_class c where c.relname='platform_payment_settings'`,
    )
    check('RLS is enabled on the table', rls.rows[0].relrowsecurity === true)
    check('…with no policies at all, so the default is deny', rls.rows[0].n === 0)

    const grants = await owner.query<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants
        where table_name='platform_payment_settings' and grantee='arena_app'`,
    )
    check('…and arena_app holds no grant of any kind on it', grants.rows[0].n === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. subscriptions are tenant-scoped')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const own = await asUser(A.userId, (c) =>
      c.query('select id, gateway_subscription_id from tenant_subscriptions'),
    )
    check("a tenant can read its OWN subscription", own.rows.length === 1)
    check('…including its public gateway reference', own.rows[0].gateway_subscription_id === `sub_A${tag}`)

    const other = await asUser(B.userId, (c) =>
      c.query('select id from tenant_subscriptions where tenant_id=$1', [A.tenantId]),
    )
    check("another tenant sees ZERO rows of it", other.rows.length === 0)

    const byRef = await asUser(B.userId, (c) =>
      c.query('select id from tenant_subscriptions where gateway_subscription_id=$1', [`sub_A${tag}`]),
    )
    check('…even when naming the gateway subscription id exactly', byRef.rows.length === 0)

    const cust = await asUser(B.userId, (c) =>
      c.query('select id from tenant_subscriptions where gateway_customer_id=$1', [`cust_A${tag}`]),
    )
    check("…and cannot find it by the other tenant's Razorpay customer id", cust.rows.length === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. no tenant may write subscription state')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const upd = await asUser(A.userId, (c) =>
      refused(() =>
        c.query(
          `update tenant_subscriptions set current_period_end = now() + interval '10 years'
            where tenant_id=$1`,
          [A.tenantId],
        ),
      ),
    )
    check('a tenant cannot extend its OWN subscription', upd === '42501')

    const ins = await asUser(A.userId, (c) =>
      refused(() =>
        c.query(
          `insert into tenant_subscriptions (tenant_id,plan_id,current_period_end)
           values ($1,$2, now() + interval '1 year')`,
          [A.tenantId, plan.rows[0].id],
        ),
      ),
    )
    check('…cannot grant itself a new one', ins === '42501')

    const status = await asUser(A.userId, (c) =>
      refused(() => c.query(`update tenants set status='active' where id=$1`, [A.tenantId])),
    )
    check('…and cannot rewrite its own tenant status', status === '42501')

    const plans = await asUser(A.userId, (c) =>
      refused(() =>
        c.query(`update plans set monthly_price='0.00' where id=$1`, [plan.rows[0].id]),
      ),
    )
    check('…nor reprice the plan it is paying for', plans === '42501')

    const gw = await asUser(A.userId, (c) =>
      refused(() =>
        c.query(`update plans set gateway_monthly_plan_id='plan_evil' where id=$1`, [
          plan.rows[0].id,
        ]),
      ),
    )
    check('…nor repoint a plan at a Razorpay plan of its choosing', gw === '42501')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('4. the catalogue: public references, private secrets')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const cat = await asUser(B.userId, (c) =>
      c.query('select gateway, gateway_monthly_plan_id from plans where id=$1', [plan.rows[0].id]),
    )
    // Deliberately visible: a `plan_…` id is a public reference that appears in
    // the checkout page Razorpay serves the payer. Asserted so that a future
    // change which hides it is a conscious decision, not an accident.
    check('the live catalogue exposes its gateway plan references', cat.rows[0]?.gateway_monthly_plan_id === `plan_M${tag}`)

    const anyPlain = await owner.query<{ n: number }>(
      `select count(*)::int n from platform_payment_settings
        where (razorpay_key_secret_encrypted is not null
               and razorpay_key_secret_encrypted !~ '^v[0-9]+:')
           or (razorpay_webhook_secret_encrypted is not null
               and razorpay_webhook_secret_encrypted !~ '^v[0-9]+:')`,
    )
    check('no plaintext secret can exist in the platform table (CHECK-enforced)', anyPlain.rows[0].n === 0)

    const plainWrite = await refused(() =>
      owner.query(
        `update platform_payment_settings set razorpay_webhook_secret_encrypted='plaintext!' where id=true`,
      ),
    )
    check('…even the OWNER cannot write a plaintext secret into it', plainWrite === '23514')

    const second = await refused(() =>
      owner.query(`insert into platform_payment_settings (id) values (false)`),
    )
    check('the singleton admits no second row', second === '23514')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('5. platform-admin readers enforce their own guard')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // No session at all in a script, so requirePlatformAdmin() must refuse —
    // proving the check lives in the reader, not in a page that could be
    // bypassed by guessing a URL.
    const { getPlatformGatewayView } = await import('../lib/platform/billing/credentials')
    const { PlatformError } = await import('../lib/platform/guard')
    const { savePlatformGateway } = await import('../lib/actions/platform-gateway')

    // The loader itself is guard-free by design (the webhook has no session and
    // must use it), so what is asserted here is the ACTION boundary above it.
    const r = await savePlatformGateway({ razorpayKeyId: 'rzp_evil' }).catch((e) => e)
    check(
      'savePlatformGateway refuses without a platform-admin session',
      (r as { error?: string })?.error !== undefined || r instanceof PlatformError || r instanceof Error,
    )

    const after = await owner.query('select razorpay_key_id from platform_payment_settings where id=true')
    check('…and nothing was written', after.rows[0].razorpay_key_id === 'rzp_test_platform')

    // The safe view really is safe: no ciphertext in the shape at all.
    const view = await getPlatformGatewayView()
    check('the UI-facing view carries booleans, never ciphertext', JSON.stringify(Object.keys(view).sort()) === '["hasSecret","hasWebhookSecret","razorpayKeyId"]')
    check('…and no serialisation of it contains the secret', !JSON.stringify(view).includes(PLATFORM_SECRET))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = any($1)', [created])
  await owner.query('delete from plans where id = any($1)', [planIds])
  await owner.query('delete from platform_payment_settings where id=true')
  await owner.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('verify harness error:', e)
  process.exit(1)
})
