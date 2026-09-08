# Arena OS — Architecture & Delivery Plan

> Multi-tenant **Smart Booking & POS platform**. One codebase, one PostgreSQL
> database, many companies — each on its own subdomain, isolated by Row-Level
> Security. Target verticals: gaming cafes, recording/podcast/dance studios,
> VR centres.

This is the authoritative design document. It reflects decisions locked on
2026-07-29 and supersedes ad-hoc notes.

## Product decisions (locked)

| Area | Decision |
|---|---|
| **App surfaces** | **Hybrid.** Full staff/back-office app per company (every module). Plus a lightweight **public booking page** (`/book`) — no customer accounts; book by name + phone, optional online **deposit** via Razorpay, get a QR. |
| **Customer identity** | Customers are **records keyed by phone within a tenant** (no login). A public booking finds-or-creates the customer by phone. |
| **Multi-branch** | **Single-branch experience now**, but `branch_id` is on every scheduling/transaction table and each company has a primary branch. Branch switcher / per-branch reports are a later, migration-free add. |
| **Payments & tax** | **India.** In-store cash / card / UPI recorded at POS; **Razorpay** for online deposits; **GST** invoices (CGST/SGST intra-state), optional HSN/SAC. Razorpay keys are **per-tenant** (each business's own account), encrypted at rest. |
| **Deployment** | **Vercel** (Next.js) + **managed Postgres** (Neon/RDS/Supabase-pg) + owned domain with wildcard `*.arenaos.app` + TLS. |
| **Onboarding / SaaS billing** | Companies are **admin-provisioned** for MVP-1. Self-serve signup + SaaS subscription billing of tenants is a **post-MVP** module. |
| **Real-time** | **Polling** for kitchen queue / notifications (like v1), with a clean path to websockets later. |

---

## 1. Tenancy & isolation model

**Shared database + shared schema + `tenant_id` on every business row, enforced
by Postgres Row-Level Security.** The guarantee: a signed-in user can only ever
read or write rows for a tenant they are an active member of — structurally, not
by convention.

Two Postgres roles are the isolation boundary:

- **`arena_app`** — no `BYPASSRLS`, not a table owner. The running app connects
  as this role; every tenant query runs inside a transaction that sets
  `app.user_id`, so RLS scopes each row. See `db/index.ts:withUser()`.
- **`arena_owner`** — owns the tables, RLS-exempt. Used only for migrations,
  seeding, platform provisioning, auth/session lookups, and the two documented
  privileged boundaries below.

RLS identity comes from `current_setting('app.user_id')` (not a JWT). Helper
functions (`auth_tenant_ids`, `auth_role_in`, `auth_is_manager`) are
`SECURITY DEFINER` to read `memberships` without recursion.

**Every new business table follows one template** (bottom of
`db/migrations/0002_rls.sql`):

```sql
create table public.<name> (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  ... );
alter table public.<name> enable row level security;
create policy <name>_member_rw on public.<name> for all
  using (tenant_id in (select public.auth_tenant_ids()))
  with check (tenant_id in (select public.auth_tenant_ids()));
grant select, insert, update, delete on public.<name> to arena_app;
```

`tenant_id` is **never nullable** on a business table. Tighten write policies per
role (e.g. only `kitchen_staff` updates KOT status) as modules land.

### Two privileged boundaries (documented exceptions)

RLS protects tenant-vs-tenant. Two paths legitimately sit outside it and use
`arena_owner`, each gated in code:

1. **Platform admin** (`is_platform_admin` on `users`) — cross-tenant by design.
   Gated in the **data layer** (`lib/platform/data.ts` calls
   `requirePlatformAdmin()`), never trusting a page/layout guard.
2. **Public booking** (`/book`, no session) — has no `user_id` to set. Runs
   through a dedicated service pinned to the `tenant_id` resolved from the
   subdomain, touching only customer find-or-create + booking creation, with
   strict validation. The `booking_slots` exclusion constraint still guarantees
   no double-booking regardless. (See §Public booking.)

---

## 2. Surfaces & routing (subdomain model)

| Host | Purpose | Auth |
|---|---|---|
| `arenaos.app` (root) | Marketing / platform landing | — |
| `arenaos.app/admin` · `admin.arenaos.app` | **Platform admin** — manage companies, owners | Platform admin session |
| `{slug}.arenaos.app` | **Staff app** — all modules | Staff session (membership) |
| `{slug}.arenaos.app/book` | **Public booking** — link/QR, optional deposit | None (public) |
| `{slug}.arenaos.app/b/{bookingNumber}` | Booking confirmation / QR | None (holds a token) |
| `{slug}.arenaos.app/api/webhooks/razorpay` | **Tenant** deposit webhooks — the venue's OWN Razorpay account | Signature-verified against that tenant's webhook secret |
| `arenaos.app/api/webhooks/platform-razorpay` | **Platform** subscription webhooks — Arena OS's own Razorpay account, charging businesses | Signature-verified against the single platform webhook secret |

The two webhook routes are deliberately separate and share no secret, no
account and no `gateway` discriminator. The tenant one identifies its tenant
from the subdomain (each venue registers its own URL on its own account); the
platform one has no tenant in the URL at all and discovers it afterwards from
`tenant_subscriptions.gateway_subscription_id`. A tenant's secret can never
verify a platform delivery, or the reverse.

A verified `subscription.charged` on the platform route also raises the GST
invoice for that renewal, in the same transaction as the state change
(`platform_invoices`, migration 0080). It is the ONLY event that bills: the
platform account emits `payment.captured` and `invoice.paid` for the same
rupees, and acting on more than one view of a single charge would invoice a
business twice.

### Dunning — what happens when a renewal fails (AROS-113)

The policy lives in exactly one file, `lib/platform/billing/dunning-policy.ts`,
and every deadline shown to an owner is computed from it, so the billing banner
cannot promise a date the scheduled job does not honour.

| day | what happens | subscription | tenant | access |
| --- | --- | --- | --- | --- |
| 0 | renewal charge fails (`subscription.pending`) | `past_due` | `active` | **unchanged — everything works** |
| 0 / 3 / 6 | reminders: payment failed → grace reminder → final warning | — | — | unchanged |
| 7 | grace expires with no successful charge | `expired` | `suspended` | **all entitlements revoked** |
| 21 | still unpaid a fortnight after suspension | `cancelled` | `cancelled` | blocked; nothing deleted |

**Arena OS does not retry charges.** Razorpay Subscriptions owns retries; a
second retry engine here is how a business gets charged twice for one month. The
grace period is a DEADLINE on Razorpay's retries, not a schedule of our own —
in the ordinary case the gateway resolves the arrears first (a retry succeeds →
`subscription.charged` → active; retries exhausted → `subscription.halted` →
suspended) and the clock never fires. It exists for the case the webhook path
cannot cover: a delivery that never arrives. Without it one dropped webhook
means a business keeps its plan forever without paying.

**Recovery.** `past_due → active` and `suspended → active` both happen on the
next successful charge, with no new code: `applySubscriptionState()` already maps
an `active` entity to subscription `active` + tenant `active` from any
non-terminal state, and dunning only adds the clearing of the two clocks so no
stale deadline re-suspends a paying business. `cancelled → active` does NOT
happen — `cancelled` is terminal, so a late webhook cannot resurrect a closed
account. Recovering from cancellation means choosing a plan again, which creates
a new subscription; the old row, its invoices and its notices all remain.

**Enforcement stays where it was.** There is no `if (tenant.status ===
'suspended')` anywhere. Suspension moves the subscription out of the three live
statuses, `readEntitlements()` returns its empty answer, and every gate in
`lib/platform/entitlement-guard.ts` closes — which blocks CREATING limited items
and ENTERING gated modules, and never blocks reading, editing or deleting what a
business already has. Nothing is deleted at any point in the lifecycle.

`readEntitlements()` was extended in one place only: during `past_due` the
effective expiry is the LATER of `current_period_end` and the grace deadline.
`current_period_end` keeps meaning exactly what it always meant (the period an
invoice documents), and a business in grace keeps the access it is still being
asked to pay for.

**Scheduling.** `npm run billing:dunning` (`scripts/run-dunning.ts`), run hourly
by the host scheduler — the same tsx-script pattern as `reports:refresh` and
`expenses:recurring`, since this project has no cron route, job table or queue.
One transaction per subscription; every transition guarded by the status it
moves from; reminders claimed by a unique index before they are sent. Safe to
run twice, safe to interrupt.

**Notifications.** There is no email or SMS provider in this project, so nothing
is duplicated and nothing is invented. `platform_dunning_notices` records what
was sent (its unique index is what makes an hourly job unable to spam), the
owner-facing message is the billing portal's existing status banner extended
with real deadlines, and Razorpay itself mails the mandate holder about failed
charges (`customer_notify: 1`). `lib/platform/billing/dunning-notify.ts` holds
the single seam a real provider plugs into.

### Platform billing dashboard (AROS-114)

`/admin/revenue` — platform-admin only. Deliberately NOT `/admin/billing`, which
is the platform's own Razorpay account and GST letterhead; this one is the money.

**Everything is derived.** No `mrr` column, no metrics table, no rollup, no
cache. Every figure is a `filter (where …)` aggregate over `plans`,
`tenant_subscriptions`, `tenants`, `platform_invoices` and `platform_refunds`, in
one transaction so the tiles, the mix, the churn rate and the tenant table cannot
come from four different instants. The only JS is merging two already-aggregated
bucket series.

| metric | definition |
| --- | --- |
| **MRR** | `monthly` → `plans.monthly_price`; `annual` → `plans.annual_price ÷ 12`. Counted for `status = 'active'` **and** `current_period_end > now()`. Grouped by currency and never summed across them. |
| **ARR** | MRR × 12, computed once in `metrics.ts`. |
| **At-risk MRR** | the same normalisation over `past_due`. Reported beside MRR, never inside it. |
| **Mix** | counted **per tenant**, via `distinct on (tenant_id)` over the live row: trial / active / past due / suspended / cancelled / no plan. The six buckets are exclusive and sum to the tenant count. |
| **Churn** | tenants live at the range's first instant that are not live at its last, ÷ tenants live at the first. `null` when the denominator is 0 — never 0, never NaN. |
| **Revenue** | `platform_invoices` where `kind='subscription' and status='paid'`, bucketed by `invoice_date` (day/week/month); minus `platform_refunds` with `status='processed'`, bucketed by when they processed. |

Excluded from MRR and why: trials (nobody has paid), `past_due` (reported
separately), `expired`/`cancelled`, and refunds — MRR is a run-rate, so refunding
last month does not change what recurs next month. Refunds are subtracted from
*revenue over time*, which is the cash view.

**Credit notes are reported, never netted off.** A credit note carries no gateway
payment (`platform_invoices_credit_note_unpaid`, 0080) because no money moved. It
is an **obligation**, not a cash movement: an amount Arena OS owes the business,
which stays `issued` until somebody discharges it deliberately — a refund, which
does move money and *is* counted, or an explicit operator act. Nothing
auto-applies a note to a later invoice. Subtracting it from revenue here would
book the same rupees out twice: once as an unfulfilled promise, again when that
promise is actually paid.

**Refunds are bucketed by `processed_at`** (0084) — when the gateway confirmed the
money left — not by `created_at`, when the refund was *reserved*. The two are
deliberately different moments (see the refund row below), and on the timeout path
they can fall in different months. Bucketing on `created_at` made a refund
reserved on 31 March and settled on 2 April appear inside March days after March
had been read and reported.

**Churn is measured per tenant, not per subscription row** — this codebase changes
a plan by cancelling the old subscription and opening a new one, so counting rows
would register every upgrade as a churn. Liveness at a past instant is
reconstructed from `created_at`, `cancelled_at` and `current_period_end`; nothing
else is available and nothing is back-filled.

**Manual overrides**, all platform-admin only, all audited into `audit_log`:

| override | behaviour |
| --- | --- |
| **Change plan** | the existing `assignPlan()`, which still refuses to touch a subscription with a live Razorpay mandate. Old row closed, new row opened, history kept. |
| **Extend trial** | moves `current_period_end` — the field the entitlement reader actually tests. Trials only, and refused for a gateway-backed subscription, where the next webhook would overwrite it. |
| **Comp / discount** | a **credit note** — the model AROS-4 already built for proration, reused unchanged (same numbering series, same GST split, same letterhead snapshot). No second discount model, no coupon table, no comp period, no zero-price subscription. It applies **to the next invoice, and it does not apply itself**: the note is raised `issued` and stays outstanding until an operator discharges it. Auto-consuming notes was tried and removed — nothing reduces what Razorpay charges, so netting a credit off the document produced an invoice totalling less than the money captured, declared output GST on the reduced figure, and understated platform revenue by the netted amount. |
| **Refund** | reserve → instruct Razorpay → settle. A pending row counts against the invoice's refundable balance, so concurrent refunds cannot exceed it; a 4xx marks the row failed and releases the amount; a timeout leaves it pending, because releasing a cap against money that may already be gone is the one mistake that cannot be undone. `refund.processed` / `refund.failed` webhooks are authoritative. |
| **Force cancel** | the existing `cancelTenantSubscription()` — at the end of the paid period by default, `immediate` as a platform-admin-only override. The gateway is told first. The **account** is not closed; that stays a separate action. |

**Authorization.** Every reader calls `requirePlatformAdmin()` itself (a page
guard would leak into the RSC payload), and every mutation server action calls it
before parsing its input — a server action is a public POST endpoint. A refund's
tenant is read from the locked invoice row, never from the request.

Resolution: `proxy.ts` extracts the slug from the host, forwards it as
`x-tenant-slug`, and bounces the signed-out off protected routes. Reserved
subdomains (`admin`, `api`, `www`, …) never resolve to a tenant.

**Route groups** (App Router):
`app/(platform)/admin/**` · `app/(app)/**` (staff, guarded by tenant context) ·
`app/(public)/book/**` (no session) · `app/login` · `app/page.tsx` (root).

---

## 3. Auth & identity

| Principal | Store | Auth method | Notes |
|---|---|---|---|
| **Platform admin** | `users.is_platform_admin` | email + password → session cookie | Higher tier than any tenant role |
| **Staff** (owner…receptionist) | `users` + `memberships` | email + password → session cookie | Role + branch per membership |
| **Customer** | `customers` (per tenant, keyed by phone) | **none** (record only) | Public booking finds-or-creates by phone |

- Passwords: argon2id (`@node-rs/argon2`). Sessions: opaque token, only its
  SHA-256 stored, httpOnly cookie, 30-day expiry, rotation-ready.
- Login redirect is context-aware: tenant subdomain → `/dashboard`, root → `/admin`.
- A user may belong to multiple companies (multiple memberships); the active one
  is chosen by subdomain, and RLS guarantees they can't reach the others.

### Roles & permissions matrix (staff app)

| Capability | Owner | Manager | Cashier | Receptionist | Floor | Kitchen |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Bookings: create / edit / cancel | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| POS: bill, take payment, discount | ✅ | ✅ | ✅ | ➖¹ | — | — |
| Refunds / void | ✅ | ✅ | — | — | — | — |
| Food: take order | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Kitchen: update KOT status | ✅ | ✅ | — | — | — | ✅ |
| Customers: view / edit | ✅ | ✅ | ✅ | ✅ | ➖ | — |
| Settings (resources, hours, pricing, taxes, gateway) | ✅ | ✅ | — | — | — | — |
| Team: add/remove staff, set roles | ✅ | ✅² | — | — | — | — |
| Memberships / plans | ✅ | ✅ | ➖ | ➖ | — | — |
| Reports & analytics | ✅ | ✅ | — | — | — | — |
| Company profile / GSTIN / gateway keys | ✅ | ➖ | — | — | — | — |

¹ configurable · ² managers cannot grant the `owner` role · ➖ = optional/limited,
finalize per capability. Enforced at **both** the RLS layer and the action layer.

---

## 4. Data model (all modules)

Grouped by module. **Built** = already migrated (`0001`–`0005`). Scope: T=tenant,
B=branch-scoped (carries `branch_id`), G=global.

### Identity & tenancy — built
| Table | Scope | Purpose |
|---|:-:|---|
| `users` | G | Global identity; `is_platform_admin` |
| `sessions` | G | Auth sessions (hashed token) |
| `tenants` | — | Companies; `slug`, industry, status, currency, timezone |
| `branches` | T | Locations; primary branch per tenant |
| `memberships` | T/B | Staff ↔ company; role, status, denormalized email/name |

### Resources & booking — built
| Table | Scope | Purpose |
|---|:-:|---|
| `resource_types` | T | Priced catalogue (rate, buffer, capacity, colour) |
| `resources` | T/B | Individual bookable units |
| `working_hours` | T/B | Open/close per weekday |
| `bookings` | T/B | Header: customer snapshot, status, totals |
| `booking_slots` | T | Resource × time; **GiST exclusion constraint** = no overlap |

### Customers — planned
| Table | Scope | Purpose |
|---|:-:|---|
| `customers` | T | Keyed by phone; name, email, dob, tags, notes, `wallet_balance`, `loyalty_points`, membership status |
| `customer_notes` | T | Timestamped staff notes |
| `wallet_transactions` | T | Wallet ledger (credit/debit, source) |
| `loyalty_transactions` | T | Points ledger |

`bookings.customer_id` → `customers` (keep the name/phone snapshot for history).
Visit & booking history are derived from `bookings`/orders.

### POS, payments & tax — planned
| Table | Scope | Purpose |
|---|:-:|---|
| `invoices` | T/B | Per completed bill: number, subtotal, discount, `tax_breakup` (jsonb), total, GST fields |
| `payments` | T/B | One row per tender → **split payments**; method (cash/card/upi/online), Razorpay refs, `collected_by` |
| `promo_codes` | T | Code, %/fixed, validity, usage limits |
| `tax_rates` | T | Named GST rates; applied via item/service |
| `refunds` | T | Refund records linked to payments |

Money is snapshotted onto invoices/line items (never recomputed from live
prices). GST: CGST+SGST split for intra-state; store GSTIN + place-of-supply.

### Food & kitchen — planned
| Table | Scope | Purpose |
|---|:-:|---|
| `menu_categories` | T | Menu grouping |
| `menu_items` | T | Name, price, tax rate, status, image, happy-hour eligible |
| `orders` | T/B | Walk-in or booking-attached food order |
| `order_items` | T | Line items (snapshot name/price/qty) |
| `kots` | T/B | Kitchen tickets; status pending→preparing→ready→served |
| `happy_hours` | T | Time-window pricing rules |

Kitchen queue = live view of open KOT items (polling). Orders may attach to a
`booking_id` or stand alone.

### Employee management — planned
| Table | Scope | Purpose |
|---|:-:|---|
| `attendance` | T/B | Clock-in/out, date, manual flag, by membership |
| `shifts` | T/B | Assigned shift (morning/evening/night), start/end |
| `rosters` | T/B | Weekly roster grouping shifts |
| `tasks` | T/B | Assigned tasks, status, due |
| — performance | — | **Derived** (sales via `payments.collected_by`, bookings via `bookings.created_by`) |

`memberships` already models the employee profile (role, branch, contact).

### Membership plans (customer) — planned
| Table | Scope | Purpose |
|---|:-:|---|
| `membership_plans` | T | Monthly/annual; price, duration, benefits (discounts, free hours, credits, special pricing) |
| `customer_memberships` | T | Purchased plan; starts/expires, active, amount paid |

Benefits feed pricing (booking/food discounts) and wallet credits.

### Settings — partially built
| Table | Scope | Purpose |
|---|:-:|---|
| `working_hours`, `resource_types`, `resources` | T/B | **built** |
| `business_profiles` | T | Legal name, GSTIN, address, logo, invoice prefix |
| `payment_settings` | T | **Encrypted** Razorpay key/secret, deposit rules |
| `notification_settings` | T | SMS/WhatsApp templates, sender (India DLT) |
| `tax_rates`, `promo_codes`, `happy_hours` | T | shared with POS/Food |

### Cross-cutting — planned
| Table | Scope | Purpose |
|---|:-:|---|
| `audit_log` | T | Sensitive actions (refunds, role changes, deletions) |
| `notifications` | T | Outbox for SMS/email + in-app; polled by kitchen/staff |
| `sequences` | T | Per-tenant numbering (bookings, invoices, KOT) |

---

## 5. Cross-cutting concerns

- **Money:** integer-safe `numeric(10,2)`; all totals snapshotted; a single
  pricing service computes booking + food + discounts + tax → invoice.
- **GST:** tax rate per item/service; invoice stores CGST/SGST breakup, GSTIN,
  place of supply; sequential invoice numbers per tenant (legal requirement).
- **Payments:** POS records tenders (split allowed). Online deposits, and
  pay-now for a standalone/pickup order with no booking to add to, both
  create a Razorpay order with the **tenant's own** keys through the SAME
  `/api/webhooks/razorpay`, which verifies the signature and marks the
  deposit — or the order's own invoice — paid. Idempotent on payment id.
- **Per-tenant secrets:** Razorpay keys encrypted at rest (pgcrypto or app-level
  envelope encryption with a platform master key in env/KMS); decrypted only on
  the owner path when calling the gateway.
- **Notifications:** SMS/WhatsApp via a provider (MSG91 in v1) — booking
  confirmation, reminders, OTP-less. India DLT template IDs per tenant.
- **Real-time:** short-poll for kitchen queue and staff notifications; abstract
  behind a hook so websockets can replace it without UI changes.
- **Numbering & timezones:** per-tenant sequences; bookings stored as absolute
  `timestamptz`, shown in the branch/tenant timezone (`lib/booking/time.ts`).
- **File storage:** images (resources, menu, logo) on Vercel Blob or S3;
  store URLs, not blobs, in Postgres.
- **Availability engine:** pure, timezone-aware, unit-tested
  (`lib/booking/availability.ts`) — reused by staff and public booking.

---

## 6. Public booking (`/book`) — design

1. Customer opens `{slug}.arenaos.app/book` (from a link or scanned QR).
2. Picks resource type + date + duration → availability engine returns free
   times (same engine as staff).
3. Enters name + phone (+ optional email). Service finds-or-creates the
   `customers` row by phone within the tenant.
4. Optional **deposit**: create a Razorpay order (tenant keys); on success the
   webhook confirms and records a `payment`. Booking is created `confirmed`;
   balance is paid in-store.
5. Customer gets a booking number + QR (`/b/{number}`); staff scan it to check in.

Runs on the pinned-tenant owner path (no session). Rate-limited; bot-guarded;
the exclusion constraint prevents double-booking under races.

---

## 7. Deployment architecture

- **Vercel** hosts Next.js. Add the apex domain and a **wildcard** `*.arenaos.app`
  — Vercel issues wildcard TLS automatically. Root, `admin`, and every tenant
  slug resolve to the same deployment; `proxy.ts` routes by host.
- **Managed Postgres** (Neon recommended for serverless): use the **pooled**
  connection string for `arena_app` (transaction-mode pooling is compatible with
  our `SET LOCAL app.user_id` per-transaction pattern). Use a **direct**
  connection for migrations (`arena_owner`).
- **Connection pooling** is mandatory on serverless — one `pg.Pool` per lambda
  behind pgBouncer/Neon pooler; keep pool sizes small.
- **Migrations in CI:** run `scripts/migrate.ts` against the production owner URL
  as a deploy step (guarded, forward-only). `db/bootstrap.sql` is a one-time
  manual step (creates roles) per environment.
- **Custom tenant domains** (later): a `tenant_domains` table + Vercel Domains
  API; `proxy.ts` maps custom host → tenant.
- **Secrets:** `SESSION_SECRET`, DB URLs, platform encryption key, SMS provider
  keys in Vercel env; per-tenant Razorpay keys encrypted in DB.
- **Backups & monitoring:** managed PG PITR backups; error tracking (Sentry);
  uptime + webhook-failure alerts.

---

## 8. Delivery roadmap (phased)

Each phase ships a usable slice, verified (typecheck + build + RLS/integrity
scripts + HTTP drive) before the next. Each new table uses the RLS template.

| Phase | Scope | Depends on | Status |
|---|---|---|---|
| **0 — Foundation** | Tenancy + RLS, custom auth, platform admin (companies + owners), team/staff, resources, booking engine, settings (hours/resources) | — | ✅ **Done** |
| **1 — Customers + POS** | `customers` (+ link bookings), billing: `invoices`/`payments`, split payments, discounts/`promo_codes`, `tax_rates`, **GST invoices**, business profile + GSTIN settings | 0 | Next |
| **2 — Food & Kitchen** | `menu_*`, walk-in + booking food orders, `kots` + kitchen queue (polling), happy hours, menu settings | 1 | |
| **3 — Public booking + payments** | `/book` + QR, find-or-create customer by phone, **Razorpay deposits** + webhook, per-tenant gateway keys, SMS confirmations | 1 (2 optional) | |
| **4 — Employee management** | Attendance (clock in/out), shifts, weekly roster, tasks, basic performance | 0 | |
| **5 — Membership & wallet** | `membership_plans`, `customer_memberships`, wallet ledger, loyalty, plan-driven pricing | 1 | |
| **6 — Reports & analytics** | Daily revenue, occupancy, peak hours, most-used resource, food sales, membership sales, employee analytics | 1–5 | |
| **7 — Deploy hardening** | Wildcard TLS, pooling, migrations-in-CI, backups, monitoring, rate-limiting, audit log → production | all | |

**Ordering rationale:** Customers + POS first turns bookings into a real
commercial product (money in). Food is adjacent to POS. Public booking lands once
the core transaction path is solid. Employee/Membership/Reports build on the
transaction data those earlier phases produce.

**Deferred (post-MVP):** self-serve tenant signup + SaaS subscription billing;
customer accounts/portal & login; full multi-branch (switcher, per-branch reports);
custom tenant domains; websocket real-time; multi-currency.

---

## 9. Non-functional & quality

- **Security:** RLS is the backbone; the `booking_slots` exclusion constraint is
  the model for structural invariants. Regression scripts (`scripts/verify-rls.ts`,
  `verify-booking.ts`) run in CI; add one per new invariant. Platform-admin and
  public paths are the only RLS exceptions, both gated in the data layer.
- **Testing:** pure logic unit-tested (availability); DB invariants proven via
  the app role; each feature driven end-to-end over HTTP before "done".
- **Performance:** targeted indexes per access path; small pooled connections;
  reports use pre-aggregation / materialized views where needed.
- **Scalability:** shared-DB + RLS comfortably serves hundreds–thousands of
  tenants. Revisit schema-per-tenant or DB-per-tenant only for a very large or
  compliance-bound tenant — the `tenant_id` discriminator makes extraction
  mechanical.
- **Observability:** structured logs, `audit_log` for sensitive actions, webhook
  delivery tracking.

---

## 10. Current repository state (as of this doc)

- Migrations `0001`–`0005`; roles + RLS live and verified against Postgres 17.
- Staff app: `/dashboard`, `/bookings` (daily board + walk-in flow + status),
  `/settings/{resources,hours,team}`.
- Platform admin: `/admin` (companies list + create-with-owner),
  `/admin/companies/[id]` (manage, members, status, delete).
- Verification: `verify-rls.ts` (6/6), `verify-booking.ts` (5/5); availability
  unit tests; typecheck + `next build` clean.
- Seed: `npm run seed:demo` → demo company + owner + platform admin + resources
  + hours.

See `README.md` for setup/run. This document is the plan of record; update it
when decisions change.
