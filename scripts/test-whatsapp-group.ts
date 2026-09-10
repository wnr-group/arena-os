/**
 * WhatsApp group invite (0103) — the rule, the constraints, and the public read.
 *
 * Three layers, tested as three layers, because each one is a different
 * promise:
 *   1. normalizeWhatsappGroupUrl()  — pure, no database. The open-redirect gate.
 *   2. the CHECK constraints        — what a direct SQL write cannot do.
 *   3. public_whatsapp_group()      — what a spectator on another venue's
 *                                     subdomain gets back, which must be null.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-whatsapp-group.ts
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import {
  normalizeWhatsappGroupUrl,
  isWhatsappGroupUrl,
  shouldAutoRedirectToWhatsapp,
  WHATSAPP_REDIRECT_SECONDS,
} from '../lib/settings/whatsapp-group'
import { businessProfileSchema, upsertBusinessProfile } from '../lib/settings/business-profile'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, extra?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  → ${JSON.stringify(extra)}`}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function main() {
  loadEnv()

  // ════════════════════════════════════════════════════════════════════════
  section('1. the URL rule (pure — no database)')
  {
    const good = 'https://chat.whatsapp.com/AbC123DeF456xyz'
    check('a real invite is accepted', normalizeWhatsappGroupUrl(good) === good)
    check(
      'the legacy /invite/ form normalises to the modern one',
      normalizeWhatsappGroupUrl('https://chat.whatsapp.com/invite/AbC123DeF456xyz') === good,
    )
    check(
      'www is accepted and dropped',
      normalizeWhatsappGroupUrl('https://www.chat.whatsapp.com/AbC123DeF456xyz') === good,
    )
    check('surrounding whitespace is trimmed', normalizeWhatsappGroupUrl(`  ${good}  `) === good)

    // THE reason the host is an allowlist: this value drives location.href.
    check('another host is refused', normalizeWhatsappGroupUrl('https://evil.example/AbC123DeF456') === null)
    check(
      'a lookalike host is refused',
      normalizeWhatsappGroupUrl('https://chat.whatsapp.com.evil.example/AbC123DeF456') === null,
    )
    check('http is refused', normalizeWhatsappGroupUrl('http://chat.whatsapp.com/AbC123DeF456') === null)
    check('javascript: is refused', normalizeWhatsappGroupUrl('javascript:alert(1)') === null)
    check('a bare wa.me number is refused', normalizeWhatsappGroupUrl('https://wa.me/919000000000') === null)
    check('the host alone is refused', normalizeWhatsappGroupUrl('https://chat.whatsapp.com/') === null)
    check('a too-short code is refused', normalizeWhatsappGroupUrl('https://chat.whatsapp.com/abc') === null)
    check(
      'a path traversal is refused',
      normalizeWhatsappGroupUrl('https://chat.whatsapp.com/AbC123/../../x') === null,
    )
    check('not a URL at all is refused', normalizeWhatsappGroupUrl('chat.whatsapp.com/AbC123DeF456') === null)
    check('blank is null, not an error', normalizeWhatsappGroupUrl('   ') === null)
    check('null in, null out', normalizeWhatsappGroupUrl(null) === null)

    // No customer data can ride along, because there is nowhere to put it.
    check(
      'a query string is DROPPED, not preserved',
      normalizeWhatsappGroupUrl(`${good}?phone=919000000000`) === good,
    )
    check('a fragment is DROPPED', normalizeWhatsappGroupUrl(`${good}#919000000000`) === good)

    check('isWhatsappGroupUrl agrees', isWhatsappGroupUrl(good) && !isWhatsappGroupUrl('https://x.test/a'))
    check(
      'the countdown is inside the 5–8s the brief asks for',
      WHATSAPP_REDIRECT_SECONDS >= 5 && WHATSAPP_REDIRECT_SECONDS <= 8,
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('1b. WHEN the countdown may arm')
  {
    // The one state that redirects: straight off a completed, paid booking,
    // first visit, forward navigation.
    const armed = {
      fromNewBooking: true,
      awaitingPayment: false,
      alreadySpent: false,
      backForward: false,
    }
    check('a fresh, paid booking arms', shouldAutoRedirectToWhatsapp(armed))

    // /b/[token] is ALSO the check-in QR page and is linked from My Bookings.
    check(
      'opening the confirmation page without ?new=1 does NOT arm (the QR stays put)',
      !shouldAutoRedirectToWhatsapp({ ...armed, fromNewBooking: false }),
    )
    // A booking is `confirmed` before any deposit settles — including when the
    // customer dismissed the payment sheet without paying.
    check(
      'an unpaid booking does NOT arm',
      !shouldAutoRedirectToWhatsapp({ ...armed, awaitingPayment: true }),
    )
    check(
      'a second visit in the same session does NOT arm',
      !shouldAutoRedirectToWhatsapp({ ...armed, alreadySpent: true }),
    )
    // The storage-free half of the Back guard: without it, private mode loops.
    check(
      'a Back navigation does NOT arm, even when storage said nothing',
      !shouldAutoRedirectToWhatsapp({ ...armed, backForward: true }),
    )
    check(
      'the refusals compose — unpaid AND revisited still refuses',
      !shouldAutoRedirectToWhatsapp({
        ...armed,
        awaitingPayment: true,
        alreadySpent: true,
      }),
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. the save contract')
  {
    const base = { invoicePrefix: 'INV', whatsappGroupEnabled: false }
    // The flag is REQUIRED, deliberately: upsertBusinessProfile() replaces the
    // whole row, so an omitted boolean would silently switch the feature off.
    // Requiring it turned that silent regression into a compile error — and
    // caught three existing call sites that would have done exactly that.
    check(
      'omitting the enabled flag is REFUSED, not defaulted to off',
      !businessProfileSchema.safeParse({ invoicePrefix: 'INV' }).success,
    )
    check(
      'a profile stating the flag parses',
      businessProfileSchema.safeParse(base).success,
    )
    check(
      'disabled + blank is fine',
      businessProfileSchema.safeParse({ ...base, whatsappGroupUrl: '', whatsappGroupEnabled: false })
        .success,
    )
    check(
      'a bad URL is refused even when disabled',
      !businessProfileSchema.safeParse({ ...base, whatsappGroupUrl: 'https://evil.example/x' }).success,
    )
    check(
      'enabling with no link is refused',
      !businessProfileSchema.safeParse({ ...base, whatsappGroupUrl: '', whatsappGroupEnabled: true })
        .success,
    )
    check(
      'enabling with a good link is accepted',
      businessProfileSchema.safeParse({
        ...base,
        whatsappGroupUrl: 'https://chat.whatsapp.com/AbC123DeF456xyz',
        whatsappGroupEnabled: true,
      }).success,
    )
  }

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })

  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const asPublic = <T,>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$1,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug],
    )
    const tenantId = t.rows[0].id
    await owner.query('delete from business_profiles where tenant_id=$1', [tenantId])
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
      [tenantId, u.rows[0].id],
    )
    return { tenantId, userId: u.rows[0].id }
  }

  const A = await makeTenant('wag-a')
  const B = await makeTenant('wag-b')
  const URL_A = 'https://chat.whatsapp.com/TenantAAAAAAAAAAAAA'
  const URL_B = 'https://chat.whatsapp.com/TenantBBBBBBBBBBBBB'

  // ════════════════════════════════════════════════════════════════════════
  section('3. the database refuses what the rule refuses')
  {
    await owner.query(
      `insert into business_profiles (tenant_id, invoice_prefix) values ($1,'INV')
       on conflict (tenant_id) do nothing`,
      [A.tenantId],
    )

    const offHost = await refusal(() =>
      owner.query('update business_profiles set whatsapp_group_url=$2 where tenant_id=$1', [
        A.tenantId,
        'https://evil.example/AbC123DeF456',
      ]),
    )
    check('an off-host URL is refused by the CHECK', offHost !== null)
    check(
      '…naming the constraint',
      (offHost ?? '').includes('business_profiles_whatsapp_group_url'),
      offHost,
    )

    const enabledNoUrl = await refusal(() =>
      owner.query('update business_profiles set whatsapp_group_enabled=true where tenant_id=$1', [
        A.tenantId,
      ]),
    )
    check('enabled with no link is refused by the CHECK', enabledNoUrl !== null)
    check(
      '…naming the constraint',
      (enabledNoUrl ?? '').includes('business_profiles_whatsapp_group_enabled'),
      enabledNoUrl,
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. the owner saves through the real writer')
  {
    await withUser(A.userId, (tx) =>
      upsertBusinessProfile(tx, A.tenantId, {
        invoicePrefix: 'INV',
        whatsappGroupUrl: `${URL_A}?utm=x`,
        whatsappGroupEnabled: true,
      } as never),
    )
    const [row] = (
      await owner.query<{ url: string; enabled: boolean }>(
        'select whatsapp_group_url url, whatsapp_group_enabled enabled from business_profiles where tenant_id=$1',
        [A.tenantId],
      )
    ).rows
    check('the link is stored CANONICAL, query dropped', row.url === URL_A)
    check('…and enabled', row.enabled === true)

    // The writer must not be able to leave the pair in the state the CHECK forbids.
    await withUser(A.userId, (tx) =>
      upsertBusinessProfile(tx, A.tenantId, {
        invoicePrefix: 'INV',
        whatsappGroupUrl: '',
        whatsappGroupEnabled: true,
      } as never),
    )
    const [cleared] = (
      await owner.query<{ url: string | null; enabled: boolean }>(
        'select whatsapp_group_url url, whatsapp_group_enabled enabled from business_profiles where tenant_id=$1',
        [A.tenantId],
      )
    ).rows
    check('clearing the link forces enabled off rather than violating the CHECK', cleared.url === null && cleared.enabled === false)

    // Put A back, and give B its own.
    await withUser(A.userId, (tx) =>
      upsertBusinessProfile(tx, A.tenantId, {
        invoicePrefix: 'INV',
        whatsappGroupUrl: URL_A,
        whatsappGroupEnabled: true,
      } as never),
    )
    await withUser(B.userId, (tx) =>
      upsertBusinessProfile(tx, B.tenantId, {
        invoicePrefix: 'INV',
        whatsappGroupUrl: URL_B,
        whatsappGroupEnabled: true,
      } as never),
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. the public read, and tenant isolation')
  {
    const read = (pinned: string, asked: string) =>
      asPublic(pinned, (tx) =>
        tx
          .execute<{ url: string | null }>(
            sql`select public.public_whatsapp_group(${asked}::uuid) as url`,
          )
          .then((r) => r.rows[0].url),
      )

    check("a venue's own subdomain gets its own invite", (await read(A.tenantId, A.tenantId)) === URL_A)
    check('…and B gets B', (await read(B.tenantId, B.tenantId)) === URL_B)

    // THE isolation property: the argument alone must not select a row.
    check(
      "tenant B's subdomain cannot read tenant A's invite",
      (await read(B.tenantId, A.tenantId)) === null,
    )
    check(
      '…nor A read B',
      (await read(A.tenantId, B.tenantId)) === null,
    )

    // business_profiles itself stays shut on the public path — the whole
    // reason this is a SECURITY DEFINER projection and not an RLS policy.
    const direct = await asPublic(A.tenantId, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int n from public.business_profiles where tenant_id = ${A.tenantId}::uuid`,
      ),
    )
    check('business_profiles is NOT publicly readable', Number(direct.rows[0].n) === 0)

    // Disabled must read exactly like unconfigured.
    await owner.query('update business_profiles set whatsapp_group_enabled=false where tenant_id=$1', [
      A.tenantId,
    ])
    check('a disabled invite reads null', (await read(A.tenantId, A.tenantId)) === null)
    check('…while the link is still stored for later', (
      await owner.query<{ url: string }>('select whatsapp_group_url url from business_profiles where tenant_id=$1', [A.tenantId])
    ).rows[0].url === URL_A)

    await owner.query('update business_profiles set whatsapp_group_enabled=true where tenant_id=$1', [
      A.tenantId,
    ])
    check('turning it back on needs no code change', (await read(A.tenantId, A.tenantId)) === URL_A)

    const unconfigured = await makeTenant('wag-c')
    check(
      'a venue with no profile row at all reads null (not an error)',
      (await read(unconfigured.tenantId, unconfigured.tenantId)) === null,
    )
  }

  for (const t of [A, B]) {
    await owner.query('delete from business_profiles where tenant_id=$1', [t.tenantId])
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
