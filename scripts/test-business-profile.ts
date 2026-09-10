/**
 * Business profile — integration tests against a real database.
 *
 * Proves the owner-only rule at the DATABASE layer (business_write RLS) as well
 * as the shape of the data, and checks the two integrations that depend on it:
 *   - owner may write; manager and cashier may read but never write
 *   - another tenant can neither read nor write the profile
 *   - exactly one row per tenant (tenant_id is the primary key)
 *   - invoice numbering picks up the configured prefix (AROS-26)
 *   - the receipt letterhead reads legal name / GSTIN / address / logo (AROS-28)
 *
 *   npx tsx scripts/test-business-profile.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import {
  DEFAULT_INVOICE_PREFIX,
  MAX_INVOICE_PREFIX_LENGTH,
  businessProfileSchema,
  loadBusinessProfile,
  loadInvoicePrefix,
  upsertBusinessProfile,
} from '../lib/settings/business-profile'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { loadInvoiceReceipt } from '../lib/billing/receipt'
import { isOwner } from '../lib/auth/roles'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

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

  /** Run a statement as `userId`, reporting success AND rows touched. */
  async function tryAs(userId: string, q: string, params: unknown[] = []) {
    const client = await appPool.connect()
    try {
      await client.query('begin')
      await client.query(`select set_config('app.user_id',$1,true)`, [userId])
      const r = await client.query(q, params)
      await client.query('commit')
      return { ok: true as const, rowCount: r.rowCount ?? 0, rows: r.rows }
    } catch {
      await client.query('rollback')
      return { ok: false as const, rowCount: 0, rows: [] as unknown[] }
    } finally {
      client.release()
    }
  }

  type Roles = { owner: string; manager: string; cashier: string }
  type Tenant = { tenantId: string; branchId: string; resourceId: string; users: Roles }

  async function makeTenant(slug: string): Promise<Tenant> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} Pvt Ltd`, TZ])
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,address,phone)
       values ($1,'Main',true,'9 Branch Road','+914400000000')
       on conflict (tenant_id,name) do update set address=excluded.address returning id`, [tenantId])
    const mkUser = async (role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`, [`${role}@${slug}.test`])
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role])
      return u.rows[0].id
    }
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','500.00')
       on conflict (tenant_id,name) do update set hourly_rate='500.00' returning id`, [tenantId])
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
       on conflict (tenant_id,name) do update set name='S1' returning id`, [tenantId, b.rows[0].id, rt.rows[0].id])
    return {
      tenantId, branchId: b.rows[0].id, resourceId: res.rows[0].id,
      users: { owner: await mkUser('owner'), manager: await mkUser('manager'), cashier: await mkUser('cashier') },
    }
  }

  const A = await makeTenant('testbiza')
  const B = await makeTenant('testbizb')
  for (const t of [A, B]) {
    await ownerPool.query('delete from business_profiles where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  const INSERT = `insert into business_profiles (tenant_id,legal_name,invoice_prefix)
                  values ($1,$2,'INV')`

  // ── 0. shape + schema ─────────────────────────────────────────────────────
  {
    const cols = (await ownerPool.query<{ column_name: string; is_nullable: string; column_default: string }>(
      `select column_name,is_nullable,column_default from information_schema.columns
        where table_schema='public' and table_name='business_profiles' order by ordinal_position`)).rows
    // The WhatsApp pair is appended by 0103 — the venue's group invite lives on
    // the profile rather than in a table of its own.
    check('table has exactly the 11 specified columns', cols.map((c) => c.column_name).join(',') ===
      'tenant_id,legal_name,gstin,address,logo_url,invoice_prefix,place_of_supply,created_at,updated_at,whatsapp_group_url,whatsapp_group_enabled')
    check('whatsapp_group_enabled is NOT NULL default false',
      cols.find((c) => c.column_name === 'whatsapp_group_enabled')?.is_nullable === 'NO' &&
      String(cols.find((c) => c.column_name === 'whatsapp_group_enabled')?.column_default).includes('false'))
    check('invoice_prefix is NOT NULL default INV', cols.find((c) => c.column_name === 'invoice_prefix')?.is_nullable === 'NO' &&
      String(cols.find((c) => c.column_name === 'invoice_prefix')?.column_default).includes('INV'))

    const pk = (await ownerPool.query<{ d: string }>(
      `select pg_get_constraintdef(oid) d from pg_constraint
        where conrelid='public.business_profiles'::regclass and contype='p'`)).rows[0]
    check('tenant_id is the PRIMARY KEY (one profile per tenant)', pk.d === 'PRIMARY KEY (tenant_id)')
    check('there is no surrogate id column', !cols.some((c) => c.column_name === 'id'))

    const rls = (await ownerPool.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname='business_profiles'`)).rows[0]
    check('RLS is enabled', rls.relrowsecurity === true)

    const pols = (await ownerPool.query<{ policyname: string; cmd: string; qual: string; with_check: string }>(
      `select policyname,cmd,qual,with_check from pg_policies where tablename='business_profiles' order by policyname`)).rows
    check('two policies: business_select + business_write', pols.map((p) => p.policyname).join(',') === 'business_select,business_write')
    check('business_select scopes reads to the tenant', /auth_tenant_ids/.test(pols[0].qual))
    check("business_write is owner-only in USING and WITH CHECK", /auth_role_in.*owner/.test(pols[1].qual) && /auth_role_in.*owner/.test(pols[1].with_check))

    const grants = (await ownerPool.query<{ p: string }>(
      `select string_agg(privilege_type,',' order by privilege_type) p from information_schema.role_table_grants
        where grantee='arena_app' and table_name='business_profiles'`)).rows[0].p
    check('arena_app is granted select,insert,update,delete', grants === 'DELETE,INSERT,SELECT,UPDATE')

    const trg = (await ownerPool.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid='public.business_profiles'::regclass and not tgisinternal`)).rows
    check('the set_updated_at trigger is attached', trg.some((t) => t.tgname === 'trg_business_profiles_updated'))
  }

  // ── 1. owner may write ────────────────────────────────────────────────────
  {
    const r = await tryAs(A.users.owner, INSERT, [A.tenantId, 'Testbiza Pvt Ltd'])
    check('an OWNER can insert the profile', r.ok && r.rowCount === 1)

    const upd = await tryAs(A.users.owner, `update business_profiles set gstin='33AAAAA0000A1Z5' where tenant_id=$1`, [A.tenantId])
    check('an OWNER can update it', upd.ok && upd.rowCount === 1)

    const profile = await withUser(A.users.owner, (tx) => loadBusinessProfile(tx, A.tenantId))
    check('…and the change is stored', profile?.gstin === '33AAAAA0000A1Z5')
    check('created_at and updated_at are set', Boolean(profile?.createdAt) && Boolean(profile?.updatedAt))
  }

  // ── 2. manager and cashier may READ but never WRITE ───────────────────────
  {
    for (const role of ['manager', 'cashier'] as const) {
      const userId = A.users[role]
      const read = await withUser(userId, (tx) => loadBusinessProfile(tx, A.tenantId))
      check(`a ${role} CAN read the profile (business_select)`, read?.tenantId === A.tenantId)

      // RLS refuses these two DIFFERENTLY: INSERT raises on WITH CHECK, while
      // UPDATE/DELETE simply match no row through USING. Both are checked.
      const ins = await tryAs(userId, INSERT, [B.tenantId, 'nope'])
      check(`a ${role} CANNOT insert a profile`, !ins.ok)

      const upd = await tryAs(userId, `update business_profiles set legal_name='hacked' where tenant_id=$1`, [A.tenantId])
      check(`a ${role}'s UPDATE touches 0 rows`, upd.rowCount === 0)

      const del = await tryAs(userId, 'delete from business_profiles where tenant_id=$1', [A.tenantId])
      check(`a ${role}'s DELETE touches 0 rows`, del.rowCount === 0)
    }

    const after = await withUser(A.users.owner, (tx) => loadBusinessProfile(tx, A.tenantId))
    check('after all of that the profile is genuinely unchanged', after?.legalName === 'Testbiza Pvt Ltd' && after !== null)
  }

  // ── 3. cross-tenant ───────────────────────────────────────────────────────
  {
    const read = await withUser(B.users.owner, (tx) => loadBusinessProfile(tx, A.tenantId))
    check("tenant B's OWNER cannot read tenant A's profile", read === null)

    const ins = await tryAs(B.users.owner, INSERT, [A.tenantId, 'stolen'])
    check("tenant B's owner cannot insert INTO tenant A", !ins.ok)

    const upd = await tryAs(B.users.owner, `update business_profiles set legal_name='stolen' where tenant_id=$1`, [A.tenantId])
    check("tenant B's owner UPDATE of tenant A touches 0 rows", upd.rowCount === 0)

    const del = await tryAs(B.users.owner, 'delete from business_profiles where tenant_id=$1', [A.tenantId])
    check("tenant B's owner DELETE of tenant A touches 0 rows", del.rowCount === 0)

    const stillThere = await withUser(A.users.owner, (tx) => loadBusinessProfile(tx, A.tenantId))
    check("…and tenant A's profile survives intact", stillThere?.legalName === 'Testbiza Pvt Ltd')
  }

  // ── 4. exactly one row per tenant ─────────────────────────────────────────
  {
    const dupe = await tryAs(A.users.owner, INSERT, [A.tenantId, 'second row'])
    check('a SECOND profile for the same tenant is rejected (tenant_id is PK)', !dupe.ok)

    const upserted = await withUser(A.users.owner, (tx) =>
      upsertBusinessProfile(tx, A.tenantId, {
        legalName: 'Renamed Pvt Ltd', gstin: '33BBBBB1111B1Z5', address: '1 New Road',
        logoUrl: 'https://cdn.example.com/logo.png', invoicePrefix: 'TC', placeOfSupply: 'Tamil Nadu',
        whatsappGroupEnabled: false,
      }))
    check('upsert updates the existing row rather than inserting', upserted.legalName === 'Renamed Pvt Ltd')
    const count = (await ownerPool.query('select count(*)::int n from business_profiles where tenant_id=$1', [A.tenantId])).rows[0].n
    check('…and there is still exactly ONE row', count === 1)

    const row = (await ownerPool.query('select created_at, updated_at from business_profiles where tenant_id=$1', [A.tenantId])).rows[0]
    check('the updated_at trigger moved updated_at past created_at', new Date(row.updated_at) > new Date(row.created_at))

    // Blank optional fields normalise to null, not ''.
    const blanked = await withUser(A.users.owner, (tx) =>
      upsertBusinessProfile(tx, A.tenantId, { legalName: '  ', gstin: '', address: null, logoUrl: '', invoicePrefix: 'TC', placeOfSupply: undefined, whatsappGroupEnabled: false }))
    check('blank optional fields are stored as null, not empty strings', blanked.legalName === null && blanked.gstin === null && blanked.logoUrl === null)
  }

  // ── 5. the prefix contract ────────────────────────────────────────────────
  {
    // whatsappGroupEnabled is required by the schema (0103) — stated in each
    // fixture so these keep failing for the PREFIX reason rather than passing
    // or failing because of a field they are not about.
    check('Zod accepts a 1–4 character prefix', businessProfileSchema.safeParse({ invoicePrefix: 'ABCD', whatsappGroupEnabled: false }).success)
    check('Zod rejects a blank prefix', !businessProfileSchema.safeParse({ invoicePrefix: '   ', whatsappGroupEnabled: false }).success)
    check(`Zod rejects a prefix over ${MAX_INVOICE_PREFIX_LENGTH} characters`, !businessProfileSchema.safeParse({ invoicePrefix: 'TOOLONG', whatsappGroupEnabled: false }).success)
    check('Zod rejects a non-URL logo', !businessProfileSchema.safeParse({ invoicePrefix: 'INV', logoUrl: 'not-a-url', whatsappGroupEnabled: false }).success)

    const dbBlank = await tryAs(A.users.owner, `update business_profiles set invoice_prefix='   ' where tenant_id=$1`, [A.tenantId])
    check('the DB CHECK also rejects a blank prefix', !dbBlank.ok)
    const dbLong = await tryAs(A.users.owner, `update business_profiles set invoice_prefix='TOOLONG' where tenant_id=$1`, [A.tenantId])
    check('…and one that is too long', !dbLong.ok)
  }

  // ── 6. AROS-26 — numbering uses the configured prefix ─────────────────────
  {
    const makeInvoice = async (t: Tenant, n: number) => {
      const bk = await ownerPool.query<{ id: string }>(
        `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
         values ($1,$2,$3,'confirmed','0','0') returning id`, [t.tenantId, t.branchId, `BP-${n}-${t.tenantId.slice(0, 4)}`])
      const s = new Date(Date.UTC(2036, 0, n, 4, 0, 0))
      await ownerPool.query(
        `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
         values ($1,$2,$3,$4,$5,'500.00','1000.00','S1','PS5',true)`,
        [t.tenantId, bk.rows[0].id, t.resourceId, s, new Date(s.getTime() + 2 * 3600_000)])
      return withUser(t.users.owner, (tx) =>
        issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId: bk.rows[0].id }))
    }

    check('loadInvoicePrefix returns the configured prefix', (await withUser(A.users.owner, (tx) => loadInvoicePrefix(tx, A.tenantId))) === 'TC')
    const invA = await makeInvoice(A, 1)
    check(`an invoice for tenant A uses TC, not ${DEFAULT_INVOICE_PREFIX}`, invA.invoiceNumber.startsWith('TC/'))
    check('…in the full PREFIX/FY/NNNNNN shape', /^TC\/\d{4}\/\d{6}$/.test(invA.invoiceNumber))
    check('…and stays inside the 16-character GST limit', invA.invoiceNumber.length <= 16)

    // Tenant B has NO profile, so it must fall back to the default.
    check('a tenant with no profile falls back to INV', (await withUser(B.users.owner, (tx) => loadInvoicePrefix(tx, B.tenantId))) === DEFAULT_INVOICE_PREFIX)
    const invB = await makeInvoice(B, 2)
    check('…and its invoice number uses INV', invB.invoiceNumber.startsWith(`${DEFAULT_INVOICE_PREFIX}/`))

    // Changing the prefix affects only invoices raised afterwards.
    await withUser(A.users.owner, (tx) =>
      upsertBusinessProfile(tx, A.tenantId, { legalName: 'Renamed Pvt Ltd', gstin: '33BBBBB1111B1Z5', address: '1 New Road', logoUrl: 'https://cdn.example.com/logo.png', invoicePrefix: 'ARN', placeOfSupply: 'Tamil Nadu', whatsappGroupEnabled: false }))
    const invA2 = await makeInvoice(A, 3)
    check('changing the prefix applies to the NEXT invoice', invA2.invoiceNumber.startsWith('ARN/'))
    const oldStill = (await ownerPool.query('select invoice_number from invoices where id=$1', [invA.invoiceId])).rows[0].invoice_number
    check('…and does not rewrite an already-issued number', oldStill === invA.invoiceNumber)

    // ── 7. AROS-28 — the receipt letterhead reads the profile ───────────────
    const receipt = await withUser(A.users.owner, (tx) => loadInvoiceReceipt(tx, A.tenantId, invA2.invoiceId))
    check('receipt legal name comes from the profile', receipt?.business.legalName === 'Renamed Pvt Ltd')
    check('receipt GSTIN comes from the profile', receipt?.business.gstin === '33BBBBB1111B1Z5')
    check('receipt address comes from the profile', receipt?.business.address === '1 New Road')
    check('receipt logo comes from the profile', receipt?.business.logoUrl === 'https://cdn.example.com/logo.png')

    // A tenant with no profile still renders, using the fallbacks.
    const receiptB = await withUser(B.users.owner, (tx) => loadInvoiceReceipt(tx, B.tenantId, invB.invoiceId))
    check('with NO profile the receipt falls back to the tenant name', receiptB?.business.legalName === 'testbizb Pvt Ltd')
    check('…the branch address', receiptB?.business.address === '9 Branch Road')
    check('…and GSTIN stays null (nowhere else to read one from)', receiptB?.business.gstin === null)
  }

  // ── 8. role helper ────────────────────────────────────────────────────────
  check('isOwner is strictly the owner', isOwner('owner') && !isOwner('manager') && !isOwner('cashier'))

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testbiz%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
