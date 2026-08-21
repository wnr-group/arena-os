/**
 * Payment settings — integration tests against a real database.
 *
 * scripts/test-encryption.ts covers the cipher itself. This one covers the
 * table, the policies, and the storage contract:
 *   - the migrated shape: pk, FK, CHECKs, RLS, grants, trigger
 *   - THE acceptance test: what lands in the column is not the plaintext
 *   - manager/owner may write; a cashier may not, at the DATABASE layer
 *   - a cashier can still reach the publishable key id, never the secret
 *   - tenant B cannot read, decrypt, or modify tenant A's credentials
 *   - a blank secret on edit preserves the stored one
 *
 * NOTHING here prints a plaintext secret, a ciphertext, or a key.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-payment-settings.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq, isNotNull, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { paymentSettings } from '../db/schema'
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

async function main() {
  loadEnv()
  const { encryptSecret, decryptSecret, isEncryptedValue } = await import(
    '../lib/security/encryption'
  )

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  function pgCode(e: unknown): string | undefined {
    let cur: unknown = e
    for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
      const o = cur as { code?: unknown; cause?: unknown }
      if (typeof o.code === 'string') return o.code
      cur = o.cause
    }
  }

  /** Mirrors upsertPaymentSettings(): encrypt in the app, then write. */
  async function saveAs(
    userId: string,
    tenantId: string,
    keyId: string | null,
    plaintextSecret: string | null,
  ) {
    const encrypted = plaintextSecret ? encryptSecret(plaintextSecret, tenantId) : null
    try {
      const r = await withUser(userId, (tx) =>
        tx
          .insert(paymentSettings)
          .values({
            tenantId,
            razorpayKeyId: keyId,
            razorpayKeySecretEncrypted: encrypted,
          })
          .onConflictDoUpdate({
            target: paymentSettings.tenantId,
            set: {
              razorpayKeyId: keyId,
              // Absent when no new secret was typed — the preserve-on-blank rule.
              ...(encrypted ? { razorpayKeySecretEncrypted: encrypted } : {}),
            },
          })
          .returning({ tenantId: paymentSettings.tenantId }),
      )
      return { ok: true as const, rowCount: r.length, code: undefined as string | undefined }
    } catch (e) {
      return { ok: false as const, rowCount: 0, code: pgCode(e) }
    }
  }

  /** Raw row, via the OWNER connection — this is what is physically on disk. */
  const rawRow = async (tenantId: string) =>
    (await ownerPool.query('select * from payment_settings where tenant_id=$1', [tenantId]))
      .rows[0]

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

  const A = await makeTenant('testpaya')
  const B = await makeTenant('testpayb')
  for (const t of [A, B])
    await ownerPool.query('delete from payment_settings where tenant_id=$1', [t.tenantId])

  // Stand-ins for real Razorpay credentials. Never printed.
  const A_KEY_ID = `rzp_test_${randomBytes(7).toString('hex')}`
  const A_SECRET = `test-secret-${randomBytes(12).toString('hex')}`
  const B_SECRET = `test-secret-${randomBytes(12).toString('hex')}`

  // ── 1. the migrated shape ─────────────────────────────────────────────────
  {
    const cols = await ownerPool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema='public' and table_name='payment_settings'`,
    )
    const names = new Set(cols.rows.map((c) => c.column_name))
    check('the payment_settings table exists with the expected columns', ['tenant_id', 'razorpay_key_id', 'razorpay_key_secret_encrypted', 'created_at', 'updated_at'].every((c) => names.has(c)))
    check('the secret column is named ..._encrypted, not razorpay_key_secret', names.has('razorpay_key_secret_encrypted') && !names.has('razorpay_key_secret'))

    const pk = await ownerPool.query<{ attname: string }>(
      `select a.attname from pg_index i
         join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid='public.payment_settings'::regclass and i.indisprimary`,
    )
    check('tenant_id is the PRIMARY KEY (one row per tenant, structurally)', pk.rowCount === 1 && pk.rows[0].attname === 'tenant_id')

    const fk = await ownerPool.query(
      `select 1 from pg_constraint
        where conrelid='public.payment_settings'::regclass and contype='f'
          and confrelid='public.tenants'::regclass`,
    )
    check('the tenant FK exists', fk.rowCount === 1)

    const checks = await ownerPool.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid='public.payment_settings'::regclass and contype='c'`,
    )
    const cnames = new Set(checks.rows.map((c) => c.conname))
    check('a CHECK enforces that the stored secret is encrypted', cnames.has('payment_settings_secret_is_encrypted'))
    check('a CHECK forbids a secret with no key id', cnames.has('payment_settings_secret_needs_key_id'))

    const rls = await ownerPool.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid='public.payment_settings'::regclass`,
    )
    check('RLS is enabled', rls.rows[0].relrowsecurity === true)

    const pol = await ownerPool.query<{ policyname: string; cmd: string; qual: string }>(
      `select policyname, cmd, qual from pg_policies
        where schemaname='public' and tablename='payment_settings'`,
    )
    const sel = pol.rows.find((p) => p.policyname === 'payment_settings_select')
    const wr = pol.rows.find((p) => p.policyname === 'payment_settings_write')
    check('the select policy is manager-gated (the row holds ciphertext)', !!sel && /auth_is_manager/.test(sel.qual))
    check('the write policy is manager-gated', !!wr && wr.cmd === 'ALL' && /auth_is_manager/.test(wr.qual))
    check('no blanket `using (true)` policy exists', pol.rows.every((p) => p.qual?.trim() !== 'true'))

    const grants = await ownerPool.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name='payment_settings' and grantee='arena_app'`,
    )
    const held = new Set(grants.rows.map((g) => g.privilege_type))
    check('arena_app holds select/insert/update/delete', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => held.has(p)))

    const trg = await ownerPool.query(
      `select 1 from pg_trigger
        where tgrelid='public.payment_settings'::regclass and tgname='trg_payment_settings_updated'`,
    )
    check('the set_updated_at trigger is attached', trg.rowCount === 1)

    const fns = await ownerPool.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
        where pronamespace='public'::regnamespace
          and proname in ('payment_key_id','payment_secret_ciphertext')`,
    )
    check('both narrow reader functions exist as SECURITY DEFINER', fns.rowCount === 2 && fns.rows.every((f) => f.prosecdef))
  }

  // ── 2. THE acceptance test: no plaintext on disk ──────────────────────────
  {
    const r = await saveAs(A.manager, A.tenantId, A_KEY_ID, A_SECRET)
    check('a MANAGER can save credentials', r.ok && r.rowCount === 1)

    const row = await rawRow(A.tenantId)
    const stored: string = row.razorpay_key_secret_encrypted
    check('the DB does NOT contain the plaintext secret', stored !== A_SECRET)
    check('…and does not contain it as a substring either', !stored.includes(A_SECRET))
    check('…what is stored is versioned AEAD output (v1:iv:tag:ciphertext)', isEncryptedValue(stored) && stored.startsWith('v1:'))
    check('…and it decrypts back to the original, server-side only', decryptSecret(stored, A.tenantId) === A_SECRET)
    check('the key id IS stored in the clear (it is publishable)', row.razorpay_key_id === A_KEY_ID)

    // A whole-database sweep: no text column anywhere holds this plaintext.
    const leak = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from payment_settings
        where razorpay_key_id = $1 or razorpay_key_secret_encrypted = $1`,
      [A_SECRET],
    )
    check('…no column in payment_settings equals the plaintext', leak.rows[0].n === '0')

    const asOwner = await saveAs(A.owner, A.tenantId, A_KEY_ID, A_SECRET)
    check('an OWNER can save too', asOwner.ok)
    check('isManager covers owner + manager, not cashier', isManager('owner') && isManager('manager') && !isManager('cashier'))
  }

  // ── 3. the DB refuses a plaintext write outright ──────────────────────────
  {
    // The CHECK constraint is the backstop for a future code path that forgets
    // to encrypt. Written through the OWNER connection, which bypasses RLS —
    // proving the guard is the constraint itself, not the policy.
    let rejected = false
    try {
      await ownerPool.query(
        `update payment_settings set razorpay_key_secret_encrypted=$2 where tenant_id=$1`,
        [A.tenantId, A_SECRET],
      )
    } catch {
      rejected = true
    }
    check('the DB REJECTS a raw plaintext secret in the encrypted column', rejected)
    check('…and the stored ciphertext is untouched by the attempt', isEncryptedValue((await rawRow(A.tenantId)).razorpay_key_secret_encrypted))

    let noKeyIdRejected = false
    try {
      await ownerPool.query(
        `insert into payment_settings (tenant_id, razorpay_key_id, razorpay_key_secret_encrypted)
         values ($1, null, $2)`,
        [B.tenantId, encryptSecret(B_SECRET, B.tenantId)],
      )
    } catch {
      noKeyIdRejected = true
    }
    check('the DB REJECTS a secret stored with no key id', noKeyIdRejected)
  }

  // ── 4. blank secret on edit preserves the stored one ──────────────────────
  {
    const before = (await rawRow(A.tenantId)).razorpay_key_secret_encrypted
    const newKeyId = `rzp_test_${randomBytes(7).toString('hex')}`
    const r = await saveAs(A.manager, A.tenantId, newKeyId, null) // blank secret field
    check('editing with a BLANK secret succeeds', r.ok)
    const after = await rawRow(A.tenantId)
    check('…the key id changed', after.razorpay_key_id === newKeyId)
    check('…and the stored secret is byte-identical — not blanked', after.razorpay_key_secret_encrypted === before)
    check('…so it still decrypts to the original secret', decryptSecret(after.razorpay_key_secret_encrypted, A.tenantId) === A_SECRET)

    // Replacing it produces a different ciphertext for the new value.
    const replacement = `test-secret-${randomBytes(12).toString('hex')}`
    await saveAs(A.manager, A.tenantId, newKeyId, replacement)
    const replaced = await rawRow(A.tenantId)
    check('typing a new secret REPLACES the stored one', decryptSecret(replaced.razorpay_key_secret_encrypted, A.tenantId) === replacement)
    check('…and the previous ciphertext is gone', replaced.razorpay_key_secret_encrypted !== before)

    // Put the canonical secret back for the isolation tests below.
    await saveAs(A.manager, A.tenantId, A_KEY_ID, A_SECRET)
    check('…updated_at moved past created_at (trigger)', new Date((await rawRow(A.tenantId)).updated_at) > new Date((await rawRow(A.tenantId)).created_at))
  }

  // ── 5. authorization at the DATABASE layer ────────────────────────────────
  {
    await saveAs(B.manager, B.tenantId, `rzp_test_${randomBytes(7).toString('hex')}`, B_SECRET)

    // A cashier's write commits touching 0 rows — RLS hides the row from the
    // UPDATE, and the INSERT half of the upsert fails the WITH CHECK.
    const cashierSave = await saveAs(A.cashier, A.tenantId, 'rzp_test_hijacked', 'attacker-secret')
    check('a CASHIER cannot write payment settings (payment_settings_write RLS)', !cashierSave.ok || cashierSave.rowCount === 0)
    const afterCashier = await rawRow(A.tenantId)
    check('…and the credentials are genuinely unchanged', afterCashier.razorpay_key_id === A_KEY_ID && decryptSecret(afterCashier.razorpay_key_secret_encrypted, A.tenantId) === A_SECRET)

    const cashierDelete = await withUser(A.cashier, (tx) =>
      tx.delete(paymentSettings).where(eq(paymentSettings.tenantId, A.tenantId)).returning({ t: paymentSettings.tenantId }),
    )
    check("a cashier's delete touches 0 rows", cashierDelete.length === 0)

    // The whole ROW — and therefore the ciphertext — is manager-only.
    const cashierRead = await withUser(A.cashier, (tx) => tx.select().from(paymentSettings))
    check('a cashier cannot SELECT the row at all — the ciphertext is out of reach', cashierRead.length === 0)

    // But the publishable key id is reachable, through the narrow function.
    const cashierKeyId = await withUser(A.cashier, (tx) =>
      tx.execute<{ k: string | null }>(sql`select public.payment_key_id(${A.tenantId}::uuid) as k`),
    )
    check('…yet a cashier CAN read the publishable key id (Checkout needs it)', cashierKeyId.rows[0].k === A_KEY_ID)

    // And the server-only credential path works under a cashier session, which
    // is what an AROS-49 POS deposit requires.
    const cashierCipher = await withUser(A.cashier, (tx) =>
      tx.execute<{ c: string | null }>(sql`select public.payment_secret_ciphertext(${A.tenantId}::uuid) as c`),
    )
    check('…and the server-only loader can reach the CIPHERTEXT for AROS-49', isEncryptedValue(cashierCipher.rows[0].c))
    check('…which is still inert: it is ciphertext, never plaintext', cashierCipher.rows[0].c !== A_SECRET)

    const managerRead = await withUser(A.manager, (tx) =>
      tx.select({ k: paymentSettings.razorpayKeyId, has: isNotNull(paymentSettings.razorpayKeySecretEncrypted) }).from(paymentSettings),
    )
    check('a MANAGER reads the safe projection: key id + hasSecret', managerRead.length === 1 && managerRead[0].k === A_KEY_ID && managerRead[0].has === true)
  }

  // ── 6. tenant isolation ───────────────────────────────────────────────────
  {
    const aRows = await withUser(A.manager, (tx) => tx.select().from(paymentSettings))
    check("tenant A's manager sees only tenant A's row", aRows.length === 1 && aRows[0].tenantId === A.tenantId)

    const bRows = await withUser(B.manager, (tx) => tx.select().from(paymentSettings))
    check("tenant B's manager sees only tenant B's row", bRows.length === 1 && bRows[0].tenantId === B.tenantId)
    check("…and never tenant A's ciphertext", !bRows.some((r) => r.tenantId === A.tenantId))

    // Explicitly asking for tenant A's row by id still returns nothing.
    const targeted = await withUser(B.manager, (tx) =>
      tx.select().from(paymentSettings).where(eq(paymentSettings.tenantId, A.tenantId)),
    )
    check("tenant B cannot SELECT tenant A's row by passing its tenant id", targeted.length === 0)

    const fnKeyId = await withUser(B.manager, (tx) =>
      tx.execute<{ k: string | null }>(sql`select public.payment_key_id(${A.tenantId}::uuid) as k`),
    )
    check("…nor tenant A's key id through payment_key_id()", fnKeyId.rows[0].k === null)

    const fnCipher = await withUser(B.manager, (tx) =>
      tx.execute<{ c: string | null }>(sql`select public.payment_secret_ciphertext(${A.tenantId}::uuid) as c`),
    )
    check("…nor tenant A's ciphertext through payment_secret_ciphertext()", fnCipher.rows[0].c === null)

    const crossWrite = await saveAs(B.manager, A.tenantId, 'rzp_test_stolen', 'attacker-secret')
    check("tenant B cannot write INTO tenant A", !crossWrite.ok || crossWrite.rowCount === 0)
    const stillA = await rawRow(A.tenantId)
    check("…and tenant A's credentials are untouched", stillA.razorpay_key_id === A_KEY_ID)

    const crossDelete = await withUser(B.manager, (tx) =>
      tx.delete(paymentSettings).where(eq(paymentSettings.tenantId, A.tenantId)).returning({ t: paymentSettings.tenantId }),
    )
    check("tenant B cannot delete tenant A's row", crossDelete.length === 0)

    // Even holding tenant A's raw ciphertext, tenant B cannot open it: the
    // tenant id is bound in as AAD.
    const aCipher = (await rawRow(A.tenantId)).razorpay_key_secret_encrypted
    let transplantFailed = false
    try {
      decryptSecret(aCipher, B.tenantId)
    } catch {
      transplantFailed = true
    }
    check("tenant A's ciphertext cannot be decrypted as tenant B (AAD binding)", transplantFailed)
    check("…while tenant B's own secret is intact", decryptSecret((await rawRow(B.tenantId)).razorpay_key_secret_encrypted, B.tenantId) === B_SECRET)
  }

  // ── 7. clearing the secret ────────────────────────────────────────────────
  {
    const cleared = await withUser(A.manager, (tx) =>
      tx
        .update(paymentSettings)
        .set({ razorpayKeySecretEncrypted: null })
        .where(eq(paymentSettings.tenantId, A.tenantId))
        .returning({ t: paymentSettings.tenantId }),
    )
    check('a manager can clear the stored secret', cleared.length === 1)
    const row = await rawRow(A.tenantId)
    check('…the secret is NULL and the key id survives', row.razorpay_key_secret_encrypted === null && row.razorpay_key_id === A_KEY_ID)
    check('…and the row still exists (settings are not deleted)', row !== undefined)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testpay%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  // Error TYPE only — a driver error's message can quote query parameters.
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
