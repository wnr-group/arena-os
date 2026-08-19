# Arena OS — Data Model (authoritative schema spec)

Column-level schema for **every MVP-1 table**, across all modules. Built tables
(`[built]`) reflect the live migrations (`db/migrations/0001–0010`); planned
tables (`[M1]`…`[M8]`) are the design each module's data-model ticket implements.

Pairs with `docs/ARCHITECTURE.md` (rationale) and `docs/ROADMAP.md` (sequencing).
When a planned table is built, update it here and mark `[built]`.

## Conventions

- **PK:** `id uuid primary key default gen_random_uuid()` unless noted.
- **Tenancy:** every business table has `tenant_id uuid not null references tenants(id) on delete cascade`. Branch-scoped tables also carry `branch_id`.
- **Timestamps:** `created_at timestamptz not null default now()`; mutable tables add `updated_at` (kept fresh by the `set_updated_at()` trigger).
- **Money:** `numeric(10,2)`, non-negative via CHECK; totals are **snapshotted** onto invoices/line-items, never recomputed from live prices.
- **Time:** absolute instants are `timestamptz`; wall-clock config (working hours) is `time`; rendered in the tenant/branch timezone.
- **Ledgers:** wallet/loyalty balances are the **sum of an append-only ledger**, not a stored mutable number.
- **RLS:** default policy `using (tenant_id in (select auth_tenant_ids())) with check (...)`, granted to `arena_app`. Tighter per-role writes noted per table. `users`/`sessions` are global identity — **never granted to `arena_app`**.
- **Scope key:** `[T]` tenant-scoped · `[T/B]` tenant + branch · `[G]` global.

## Relationship overview

```mermaid
erDiagram
  TENANTS ||--o{ BRANCHES : has
  TENANTS ||--o{ MEMBERSHIPS : has
  USERS ||--o{ MEMBERSHIPS : "is"
  USERS ||--o{ SESSIONS : has
  TENANTS ||--o{ RESOURCE_TYPES : defines
  RESOURCE_TYPES ||--o{ RESOURCES : "instance of"
  BRANCHES ||--o{ RESOURCES : hosts
  BRANCHES ||--o{ WORKING_HOURS : has
  TENANTS ||--o{ CUSTOMERS : has
  CUSTOMERS ||--o{ BOOKINGS : places
  BRANCHES ||--o{ BOOKINGS : at
  BOOKINGS ||--o{ BOOKING_SLOTS : reserves
  RESOURCES ||--o{ BOOKING_SLOTS : "booked in"
  BOOKINGS ||--o{ ORDERS : "food on"
  ORDERS ||--o{ ORDER_ITEMS : contains
  ORDERS ||--o{ KOTS : "sent to kitchen"
  MENU_ITEMS ||--o{ ORDER_ITEMS : "snapshot of"
  BOOKINGS ||--o{ INVOICES : billed
  CUSTOMERS ||--o{ INVOICES : "billed to"
  INVOICES ||--o{ INVOICE_ITEMS : "lines"
  INVOICES ||--o{ PAYMENTS : "settled by"
  PAYMENTS ||--o{ REFUNDS : "refunded by"
  MEMBERSHIPS ||--o{ AUDIT_LOG : "acted"
  CUSTOMERS ||--o{ WALLET_TRANSACTIONS : ledger
  CUSTOMERS ||--o{ CUSTOMER_MEMBERSHIPS : holds
  MEMBERSHIP_PLANS ||--o{ CUSTOMER_MEMBERSHIPS : "instance of"
  MEMBERSHIPS ||--o{ ATTENDANCE : logs
  MEMBERSHIPS ||--o{ SHIFTS : assigned
```

---

## Identity & tenancy `[built]`

### `users` `[G]`
`id` · `email text unique not null` · `password_hash text not null` · `full_name text` · `is_platform_admin boolean not null default false` · `created_at` · `updated_at`. Not granted to `arena_app`.

### `sessions` `[G]`
`id text pk` (SHA-256 of the cookie token) · `user_id → users on delete cascade` · `expires_at timestamptz not null` · `created_at`. Index `(user_id)`. Not granted to `arena_app`.

### `tenants`
`id` · `slug text unique` (CHECK subdomain pattern) · `name text not null` · `industry tenant_industry` · `status tenant_status` · `currency text default 'INR'` · `timezone text default 'Asia/Kolkata'` · timestamps.
RLS: member `select`; owner `update`.

### `branches` `[T]`
`id` · `tenant_id` · `name text not null` · `address` · `phone` · `timezone` · `is_primary boolean` · `status branch_status` · timestamps. Unique `(tenant_id, name)`; index `(tenant_id)`. RLS: member `select`, manager write.

### `memberships` `[T/B]`
`id` · `tenant_id` · `user_id → users` · `branch_id → branches null` · `role member_role` · `status member_status` · `full_name` · `email` · `phone` · timestamps. Unique `(tenant_id, user_id)`; indexes `(user_id)`, `(tenant_id)`. RLS: member `select`, manager write.

**Enums:** `tenant_status(trial|active|suspended|cancelled)`, `tenant_industry(gaming_cafe|recording_studio|podcast_studio|dance_studio|vr_centre|other)`, `branch_status(active|inactive)`, `member_role(owner|manager|cashier|kitchen_staff|floor_staff|receptionist)`, `member_status(invited|active|disabled)`.

## Resources & booking `[built]`

### `resource_types` `[T]`
`id` · `tenant_id` · `name` · `description` · `hourly_rate numeric(10,2)` · `buffer_minutes int` · `capacity int null` · `color text` · `is_active boolean` · timestamps. Unique `(tenant_id, name)`.

### `resources` `[T/B]`
`id` · `tenant_id` · `branch_id not null` · `resource_type_id → resource_types` · `name` · `hourly_rate_override numeric null` · `status resource_status` · `sort_order int` · timestamps. Unique `(tenant_id, name)`.

### `working_hours` `[T/B]`
`id` · `tenant_id` · `branch_id not null` · `day_of_week smallint (0–6)` · `open_time time` · `close_time time` · `is_closed boolean` · timestamps. Unique `(branch_id, day_of_week)`; CHECK closed-or-close>open.

### `bookings` `[T/B]`
`id` · `tenant_id` · `branch_id` · `booking_number text` · `customer_name/phone/email` (snapshot) · `status booking_status` · `source booking_source` · `subtotal/discount/tax/total/deposit numeric` · `notes` · `created_by → memberships null` · timestamps · `checked_in_at/completed_at/cancelled_at`. Unique `(tenant_id, booking_number)`. *(M1 adds `customer_id → customers`.)*

### `booking_slots` `[T]`
`id` · `tenant_id` · `booking_id → bookings on delete cascade` · `resource_id → resources` · `starts_at timestamptz` · `ends_at timestamptz` · `rate_applied` · `slot_total` · `resource_name`/`resource_type_name` (snapshot) · `active boolean`.
**Exclusion constraint** `exclude using gist (resource_id with =, tstzrange(starts_at,ends_at) with &&) where (active)` → no overlapping active slot on a resource. Trigger syncs `active` from booking status.

**Enums:** `resource_status(available|maintenance|inactive)`, `booking_status(confirmed|checked_in|completed|cancelled|no_show)`, `booking_source(walk_in|staff|online)`.

---

## M1 — Customers `[M1]`

### `customers` `[T]`
`id` · `tenant_id` · `phone text not null` · `name` · `email` · `dob date` · `tags text[]` · `membership_status text` · `created_at` · `updated_at`. **Unique `(tenant_id, phone)`**; index `(tenant_id)`. RLS member rw.

### `customer_notes` `[T]`
`id` · `tenant_id` · `customer_id` · `body text` · `created_by → memberships null` · `created_at` · `updated_at`. Index `(customer_id)`. RLS member rw.
Editable, so it carries `updated_at` under the `set_updated_at()` trigger; an edit changes `body` only, keeping the original author and time (a note whose `updated_at` is later than its `created_at` is shown as edited). The customer link is the **composite FK** `(tenant_id, customer_id) → customers(tenant_id, id) on delete cascade` — referential integrity is not subject to RLS, so keying on the tenant too is what makes a note against another tenant's customer unwritable (same device as `bookings` in 0008).

### `wallet_transactions` `[T]`  (append-only ledger)
`id` · `tenant_id` · `customer_id → customers` · `amount numeric(10,2)` (signed: + credit / − debit) · `reason text` · `source_type text` (topup|booking|refund…) · `source_id uuid null` · `created_by → memberships null` · `created_at`. Balance = `sum(amount)`. Index `(customer_id)`.

### `loyalty_transactions` `[T]`  (append-only ledger)
`id` · `tenant_id` · `customer_id` · `points int` (signed) · `reason` · `source_type/source_id` · `created_at`. Balance = `sum(points)`.

## M1 — POS / Billing

### `invoices` `[T/B]` `[built]`
`id` · `tenant_id` · `branch_id → branches on delete restrict` · `invoice_number text` · `booking_id null` · `customer_id null` · `subtotal` · `discount` · `promo_code_id uuid null` · `tax_total` · `tax_breakup jsonb not null default '[]'` (CGST/SGST lines) · `total` · `status invoice_status(draft|issued|paid|void)` · `place_of_supply text` · `issued_at` · timestamps. **Unique `(tenant_id, invoice_number)`** (the GST per-tenant numbering rule); unique `(tenant_id, id)`; index `(tenant_id, branch_id)`; `set_updated_at()` trigger. Money columns CHECK `>= 0`.
RLS member rw (void = owner/manager, enforced in the action layer). The booking and customer links are **composite FKs** `(tenant_id, booking_id) → bookings(tenant_id, id)` and `(tenant_id, customer_id) → customers(tenant_id, id)`, both `on delete set null` — an invoice outlives the booking/customer it was raised for, and cannot point at another tenant's row (same device as `bookings` in 0008). `promo_code_id` carries no FK until `promo_codes` lands.

### `invoice_items` `[T]` `[built]`
`id` · `tenant_id` · `invoice_id` · `kind text(booking|food|membership|adjustment)` (CHECK) · `source_id uuid null` · `description text` · `qty numeric(10,2) > 0` · `unit_price` · `tax_rate numeric(5,2)` (a **percentage**, so it mirrors `tax_rates.percent`, not money) · `line_total` · `created_at` (all snapshot). Index `(invoice_id)`. Composite FK `(tenant_id, invoice_id) → invoices(tenant_id, id) on delete cascade`. `source_id` is a deliberate soft pointer — the line must survive deletion of whatever produced it.

### `payments` `[T/B]` `[built]`  (split payments = many rows per invoice)
`id` · `tenant_id` · `branch_id` · `invoice_id` · `method payment_method(cash|card|upi|online|wallet)` · `amount numeric(10,2)` CHECK `> 0` · `status payment_status(pending|captured|failed|refunded)` · `gateway text null` · `gateway_order_id/gateway_payment_id/gateway_signature text null` · `collected_by → memberships null` · `created_at` · `updated_at`. Unique `(tenant_id, id)`; index `(invoice_id)`; `set_updated_at()` trigger (a tender moves pending → captured). Composite FK `(tenant_id, invoice_id) → invoices(tenant_id, id) on delete cascade`. That `sum(amount) ≤ invoice.total` stays a service rule, not a constraint — a partial settlement is legitimate.

### `refunds` `[T]` `[built]`
`id` · `tenant_id` · `payment_id` · `amount numeric(10,2)` CHECK `> 0` · `reason` · `created_by → memberships null` · `created_at`. Index `(payment_id)`. Composite FK `(tenant_id, payment_id) → payments(tenant_id, id) on delete cascade`.
RLS: member `select`, **owner/manager write** via `auth_is_manager()`. Append-only — `arena_app` is granted `select, insert` only, so no code path can update or delete a refund record.

### `promo_codes` `[T]`
`id` · `tenant_id` · `code text` · `discount_type(percentage|fixed)` · `discount_value numeric` · `valid_from/valid_until timestamptz` · `max_uses int null` · `uses int default 0` · `is_active boolean` · timestamps. Unique `(tenant_id, upper(code))`.

### `tax_rates` `[T]`
`id` · `tenant_id` · `name text` · `percent numeric(5,2)` · `is_active boolean` · timestamps.

### `sequences` `[T]` `[built]`  (per-tenant human numbers)
`tenant_id` · `kind text(booking|invoice|kot)` (CHECK) · `period text` (e.g. YYYYMMDD or YYYY, `-` for never-resetting) · `value int >= 0`. PK `(tenant_id, kind, period)` — an upsert on that key is what serialises the increment, giving gap-free per-scope numbering. RLS tenant-scoped; granted `select, insert, update` (a counter is reset by writing 0, never deleted).

### `audit_log` `[T]` `[built]`
`id` · `tenant_id` · `actor_membership_id → memberships null` (nullable so the entry survives the staff member leaving) · `action text` · `entity_type text` · `entity_id uuid null` · `before jsonb` · `after jsonb` · `created_at`. Index `(tenant_id, created_at desc)`.
RLS: tenant `select` + tenant `insert` — deliberately **no update or delete policy**, and `arena_app` is granted `select, insert` only, so the trail cannot be rewritten or erased from the app path.

## M1 — Settings `[M1]`

### `business_profiles` `[T]`
`tenant_id pk → tenants` · `legal_name` · `gstin text` · `address` · `logo_url` · `invoice_prefix text` · `place_of_supply` · timestamps. Owner-only writes.

**Enums** `[built]`**:** `invoice_status(draft|issued|paid|void)`, `payment_method(cash|card|upi|online|wallet)`, `payment_status(pending|captured|failed|refunded)`.

---

## M2 — Food & Kitchen `[M2]`

### `menu_categories` `[T]`
`id` · `tenant_id` · `name` · `sort_order int` · `is_active boolean` · timestamps. Unique `(tenant_id, name)`.

### `menu_items` `[T]`
`id` · `tenant_id` · `category_id → menu_categories` · `name` · `price numeric(10,2)` · `tax_rate_id → tax_rates null` · `status(available|out_of_stock|hidden)` · `image_url` · `happy_hour_eligible boolean` · timestamps.

### `happy_hours` `[T]`
`id` · `tenant_id` · `name` · `days_of_week smallint[]` · `start_time/end_time time` · `discount_type/discount_value` · `is_active boolean` · timestamps.

### `orders` `[T/B]`
`id` · `tenant_id` · `branch_id` · `booking_id → bookings null` · `order_number text` · `status(open|billed|cancelled)` · `created_by → memberships null` · timestamps.

### `order_items` `[T]`
`id` · `tenant_id` · `order_id → orders on delete cascade` · `menu_item_id → menu_items null` · `item_name`/`unit_price`/`tax_rate` (snapshot) · `qty int` · `line_total` · `special_instructions text`.

### `kots` `[T/B]`
`id` · `tenant_id` · `branch_id` · `order_id → orders` · `kot_number text` · `status kot_status(pending|preparing|ready|served|cancelled)` · `created_at` · `updated_at`. Kitchen queue = open KOTs. `kitchen_staff` may update `status`.

---

## M3 — Public booking, Payments, Notifications `[M3]`

*(Public booking reuses `bookings`/`booking_slots`/`customers`; deposits use `payments` with `method=online`.)*

### `payment_settings` `[T]`
`tenant_id pk` · `provider text default 'razorpay'` · `key_id text` · `key_secret_encrypted bytea` (envelope-encrypted; never returned plaintext) · `webhook_secret_encrypted bytea` · `deposit_type(percentage|fixed)` · `deposit_value numeric` · `is_live boolean` · timestamps. Owner-only.

### `notification_settings` `[T]`
`tenant_id pk` · `sms_provider text` · `sms_sender_id text` · `dlt_templates jsonb` (event → template id) · `enabled boolean` · timestamps.

### `notifications` `[T]`  (outbox)
`id` · `tenant_id` · `channel(sms|email|inapp)` · `to_address text` · `template_key text` · `payload jsonb` · `status(queued|sent|failed)` · `attempts int` · `last_error text` · `booking_id null` · `created_at` · `sent_at`. Index `(tenant_id, status)`.

**Booking QR:** `bookings` gains `qr_token text` (unguessable) for `/b/{number}` check-in.

---

## M4 — Employee management

### `attendance` `[T/B]` `[built]`
`id` · `tenant_id` · `branch_id` · `membership_id → memberships` · `work_date date` · `clock_in timestamptz` · `clock_out timestamptz null` · `is_manual boolean` · `note text` · timestamps. Index `(tenant_id, work_date)`, `(membership_id)`. One row per (membership, work_date) in the common case — staff clock in/out their own row; managers may add/correct any row (marks `is_manual = true`). RLS: any active member rw (tenant-scoped); action layer restricts staff to their own membership.

### `rosters` `[T/B]` `[built]`
`id` · `tenant_id` · `branch_id` · `week_start date` · `note text` · timestamps. Unique `(branch_id, week_start)` — one roster per branch per week; the builder upserts on this key.

### `shifts` `[T/B]` `[built]`
`id` · `tenant_id` · `branch_id` · `membership_id → memberships` · `roster_id → rosters null` · `shift_date date` · `type shift_type(morning|evening|night)` · `starts time` · `ends time` · timestamps. Index `(membership_id, shift_date)`. RLS: any active member rw (staff can see the whole roster); action layer restricts building/editing to managers.

**Enums:** `shift_type(morning|evening|night)`.

### `tasks` `[T/B]` `[built]`
`id` · `tenant_id` · `branch_id null` · `title` · `description` · `assigned_to → memberships null` · `status task_status(open|in_progress|done)` · `due_date date null` · `created_by → memberships null` · timestamps. Index `(assigned_to)`. RLS: any active member rw; action layer restricts create/reassign/delete to managers, status updates to the assignee or a manager.

**Enums:** `task_status(open|in_progress|done)`.

*(Performance metrics are **derived** — no table — from `payments.collected_by`, `bookings.created_by`, `attendance`.)*

---

## M5 — Membership & wallet `[M5]`

### `membership_plans` `[T]`
`id` · `tenant_id` · `name` · `price numeric` · `duration_days int` · `benefits jsonb` (`{booking_discount_pct, food_discount_pct, free_hours, credits, special_pricing}`) · `is_active boolean` · `display_order int` · timestamps.

### `customer_memberships` `[T]`
`id` · `tenant_id` · `customer_id → customers` · `plan_id → membership_plans` · `starts_at` · `expires_at` · `is_active boolean` · `amount_paid numeric` · `invoice_id → invoices null` · timestamps. Index `(customer_id, is_active)`, `(expires_at)`.

*(Wallet & loyalty use `wallet_transactions`/`loyalty_transactions` from M1. Wallet as a tender = a `payments` row with `method=wallet` + a debit ledger entry.)*

---

## M6 — Reports `[M6]`

Read-only. No new base tables; prefer **materialized views** / rollups over
`bookings`, `booking_slots`, `invoices`, `payments`, `orders`,
`customer_memberships`, `attendance` — refreshed on a schedule. Examples:
`mv_daily_revenue(tenant_id, branch_id, day, gross, discount, tax, net)`,
`mv_resource_occupancy(tenant_id, resource_id, day, booked_minutes, open_minutes)`.
All filtered by `tenant_id`; export to CSV. (Add a `report_snapshots` table only if
historical immutability is needed.)

---

## M7 / M8 — Hardening & launch `[M7]` `[M8]`

Mostly non-schema (infra, security, ops). Schema touches:
- `audit_log` coverage extended to role/company/gateway-key changes (table exists from M1).
- Optional `rate_limits` (or Redis/edge KV) for throttling counters — likely **not** a Postgres table (use edge KV).
- Data-lifecycle: per-tenant **export** (read) + **hard-delete** (cascades via `tenant_id ON DELETE CASCADE`, already in place).
- Later/deferred: `tenant_domains(tenant_id, hostname unique, verified_at)` for custom domains.

---

## M11 — Payroll & Salary `[M11]`

### `salary_structures` `[T]` `[built]`
`id` · `tenant_id` · `membership_id → memberships` · `base numeric(10,2)` · `allowances jsonb` (`SalaryComponent[] = {label, amount}[]`) · `deductions jsonb` (same shape) · `effective_from date` · `created_by → memberships null` · timestamps. Unique `(membership_id, effective_from)` — a raise is a new row dated from when it takes effect, never a rewrite of an old one, so past pay stays reconstructable once the payroll run (AROS-104) starts snapshotting payslips from this. RLS: **owner-only** for select AND write via `auth_role_in() = 'owner'` — compensation is more sensitive than the business's own legal identity (`business_profiles`, which is member-select/owner-write).

### `employee_advances` `[T]` `[built]`
`id` · `tenant_id` · `membership_id → memberships` · `amount numeric(10,2)` · `instalment_amount numeric(10,2)` · `note text null` · `given_at date` · `created_by → memberships null` · timestamps. Unique `(tenant_id, id)` (composite-FK target for the recoveries ledger below). The PLAN side only — who was given how much and the flat instalment to recover each payroll period. RLS: owner-only, same as `salary_structures`.

### `employee_advance_recoveries` `[T]` `[built]`  (append-only ledger)
`id` · `tenant_id` · `advance_id → employee_advances` · `amount numeric(10,2)` (signed: + recovery / − correction) · `source_type text null` (`'payroll'`, written by AROS-104) · `source_id uuid null` (the payslip, a soft pointer — no FK, same device as `invoice_items.source_id`) · `created_by → memberships null` · `created_at`. Composite FK `(tenant_id, advance_id) → employee_advances(tenant_id, id) on delete cascade`. Index `(advance_id)`. Outstanding is always **derived** as `employee_advances.amount − sum(recoveries.amount)`, never a stored column — same shape as `wallet_transactions`/`loyalty_transactions` (M5). RLS: owner-only. Grants: **select, insert only** (no update/delete) — stricter than wallet/loyalty, matching `refunds`: a payroll deduction record must never be editable after the fact, only reversed with an opposite-signed row.

### `payslips` `[T]` `[built]`
`id` · `tenant_id` · `membership_id → memberships` · `period text` (`'YYYY-MM'`, check-constrained) · `base numeric(10,2)` · `allowances jsonb` · `deductions jsonb` (both snapshotted verbatim from the `salary_structures` row used — the "line breakdown") · `days_in_period smallint` · `days_present smallint` · `gross numeric(10,2)` (`(base + Σallowances) × days_present / days_in_period`, rounded once) · `deductions_total numeric(10,2)` (Σdeductions, **not** prorated by attendance) · `advance_instalment numeric(10,2)` (what this payslip actually recovered, clamped to both outstanding balance and what the payslip can afford) · `net_pay numeric(10,2)` (floored at 0 — a payslip never prints negative) · `created_by → memberships null` · `created_at`. Unique `(membership_id, period)` — the idempotency guarantee: the run (`lib/payroll/run.ts`) pre-checks for an existing payslip in the period and blocks the whole run rather than upserting, because upserting would mean re-posting advance recoveries the (insert-only) ledger can never un-post. RLS (AROS-105, migration 0030): **SELECT** is self-service — `membership_id = auth_membership_id(tenant_id)` — plus owner/manager see every row (`auth_is_manager`), deliberately wider than `salary_structures`/`employee_advances`, since a payslip is "about" the employee it belongs to the way attendance is. **INSERT** stays owner-only, unchanged from 0029. Grants: **select, insert only** — a payslip is a financial record of what was actually paid, corrected by the next run rather than edited in place.

---

## Change log

- 2026-08-01 — Initial full spec. Built tables reflect migrations 0001–0005;
  M1–M8 are the target schema per their data-model tickets. Update table blocks
  to `[built]` as migrations land, keeping `db/schema.ts` in sync.
- 2026-08-05 — Migration 0006 adds `attendance` (M4-A): clock in/out, manager
  correction, marked `[built]`.
- 2026-08-05 — Migration 0007 adds `rosters`/`shifts` (M4-B): weekly roster
  builder, staff shift assignment, marked `[built]`.
- 2026-08-05 — Migration 0008 adds `tasks` (M4-C): manager assigns, assignee
  tracks status, marked `[built]`.
- 2026-08-06 — `customer_notes` gains `updated_at` (notes are now editable from
  the profile) and a composite `(tenant_id, customer_id)` FK — migration 0009.
- 2026-08-07 — Billing data model built — migration 0010: `invoices`,
  `invoice_items`, `payments`, `refunds`, `sequences`, `audit_log` plus the
  `invoice_status` / `payment_method` / `payment_status` enums. `bookings` gains
  a `unique (tenant_id, id)` key so invoices can use the composite-FK device.
- 2026-08-07 — `promo_codes` (0011) and `business_profiles` (0012) built, so an
  invoice's `promo_code_id` now carries a composite FK and the invoice prefix
  comes from the tenant's profile rather than a constant.
- NOTE — the customer/billing branch and the employee/menu/orders branch were
  developed in parallel and BOTH numbered their migrations 0006–0013, so the
  directory currently holds two files per number (e.g. `0010_billing.sql` and
  `0010_menu.sql`). The runner applies them in filename order, which happens to
  satisfy every dependency, but the numbering needs reconciling.
- 2026-08-19 — `salary_structures` (M11, first ticket) built — migration 0027:
  base pay + allowances/deductions per membership, versioned by
  `effective_from` so a raise never overwrites past pay. Owner-only RLS for
  both read and write. Foundation for the payroll run (AROS-104).
- 2026-08-19 — `employee_advances` + `employee_advance_recoveries` (M11,
  second ticket) built — migration 0028: staff advances/loans plus their
  append-only recovery ledger, outstanding always derived (never stored),
  same shape as the wallet/loyalty ledgers. The recoveries table is
  insert-only at the grant level (like `refunds`), stricter than
  wallet/loyalty. The payroll run (AROS-104) will write recovery rows as it
  deducts each period's instalment.
- 2026-08-19 — `payslips` (M11, third ticket, AROS-104) built — migration
  0029: the payroll run's output. One row per (membership, period), every
  money/attendance figure a snapshot so a later salary-structure edit or
  attendance correction never rewrites a past payslip. Unique
  `(membership_id, period)` makes a run idempotent — a re-run of a period
  that already has payslips is rejected outright rather than upserting, since
  the advance-recoveries ledger it posts to is insert-only and can't be
  un-posted. Owner-only RLS, select+insert-only grants, same as
  `employee_advance_recoveries`.
- 2026-08-19 — payslip self-view (M11, fourth ticket, AROS-105) — migration
  0030: widened `payslips` SELECT so a staff member sees their own payslips
  (new `auth_membership_id()` helper, same SECURITY DEFINER shape as
  `auth_role_in()`) while owner/manager keep seeing everyone's. INSERT is
  unchanged — still owner-only, only the payroll run writes these.
- 2026-08-19 — Payroll Cost Report (M11, fifth ticket) — `lib/reports/payroll.ts`
  + `/reports/payroll`, manager-guarded. No schema change: aggregates
  `payslips` by period range, per-employee and total (the wage-bill figure
  M12's P&L, AROS-86, will read). The ticket named the M6-D "reporting infra"
  epic (AROS-64, a tenant-safe `security_barrier` view + CSV pattern) as a
  dependency, but that epic was never built in this codebase — this instead
  follows the plain RLS-scoped aggregate-query pattern `getEmployeeAnalytics()`
  (M6-C) already established, plus a new reusable client-side CSV export
  (`components/reports/ExportCsvButton.tsx`, no library, no server round trip).
