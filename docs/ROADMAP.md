# Arena OS — Production Roadmap

Goal: take Arena OS from its verified foundation to a **production launch of
MVP-1** (staff app with all modules + hybrid public booking), for real paying
companies. This is the milestone/epic map; per-story detail lives in tickets.
Pairs with `docs/ARCHITECTURE.md` (design of record).

## Release strategy

- **Environments:** `local` (Docker Postgres) → `staging` (Vercel preview + Neon
  branch) → `production` (Vercel + Neon).
- **Branching:** trunk-based; every ticket = a PR; migrations forward-only.
- **Cadence:** ship milestone by milestone; each has an **exit gate** (below)
  that must be green (typecheck + build + verify scripts + E2E drive) before the
  next milestone starts. Production hardening (M7) runs partly *continuously*.

## Definition of Done (every story)

1. Code + migration (RLS template applied; `tenant_id` non-null).
2. `db/schema.ts` mirrored; typecheck + `next build` clean.
3. Role-gated at **both** RLS and action layers.
4. Tests: pure logic unit-tested; new invariant → a `verify-*.ts` assertion.
5. Driven end-to-end over HTTP (or UI) and observed working.
6. Docs touched if behaviour/contract changed.

## Milestones

| # | Milestone | Goal | Exit gate |
|---|---|---|---|
| **M0** | Foundation | Tenancy+RLS, auth, platform admin, team, resources, booking engine, settings | ✅ Done & verified |
| **M1** | Customers + POS/Billing | Turn bookings into money: customers, GST invoices, split payments | Bill a booking → GST invoice → payment(s) recorded; refund works |
| **M2** | Food & Kitchen | Menu, orders, KOT, kitchen queue | Order food → KOT in kitchen → status flow → billed on same invoice |
| **M3** | Public booking + Payments + Notifications | Hybrid `/book`, Razorpay deposits, SMS | Public booking + deposit → webhook confirms → SMS sent → QR check-in |
| **M4** | Employee Management | Attendance, shifts, roster, tasks, performance | Clock in/out; roster set; task lifecycle; performance reflects data |
| **M5** | Membership & Wallet | Plans, customer memberships, wallet, loyalty | Sell plan → benefits apply at billing → wallet debit/credit works |
| **M6** | Reports & Analytics | Operational dashboards | Dashboards reconcile with seeded source data; CSV export |
| **M7** | Production Hardening | Security, infra/CI, observability, perf, backups | Launch checklist green; staging soak passes |
| **M8** | Launch / Go-live | Onboard first real tenant on production | Smoke tests pass; rollback rehearsed; support live |

---

## M1 — Customers + POS/Billing

**Epic M1-A Customers**
- Migration: `customers` (phone-keyed per tenant), `customer_notes`, `wallet_transactions`, `loyalty_transactions` + RLS.
- Customer find-or-create-by-phone service.
- Customers list + search UI.
- Customer profile page: booking/visit history, notes, tags, wallet & loyalty balance.
- Link `bookings.customer_id`; keep name/phone snapshot.
- Customer notes + tags CRUD.

**Epic M1-B POS / Billing**
- Migration: `invoices`, `payments`, `refunds`, per-tenant `sequences` + RLS.
- Pricing & tax service (subtotal → discount → GST → total; snapshotted).
- POS bill screen for a booking: line items, discount, tax.
- Split payments (multiple `payments` rows; cash/card/upi).
- GST invoice: CGST/SGST breakup, GSTIN, sequential number; printable/PDF receipt.
- `promo_codes` table + apply-at-billing.
- Refund / void (owner/manager) + `audit_log` entry.

**Epic M1-C Settings (business & tax)**
- `business_profiles` (GSTIN, legal name, address, logo, invoice prefix) + UI.
- `tax_rates` management UI.
- `promo_codes` management UI.

---

## M2 — Food & Kitchen

**Epic M2-A Menu**
- Migration: `menu_categories`, `menu_items`, `happy_hours` + RLS.
- Menu management UI (CRUD, image upload, tax rate, availability).
- Happy-hour pricing rules + application at ordering.

**Epic M2-B Ordering**
- Migration: `orders`, `order_items` + RLS.
- Add food to a booking; standalone walk-in order.
- Food lines flow into the booking's POS bill.

**Epic M2-C Kitchen**
- Migration: `kots` + RLS.
- Kitchen queue screen (polling) + KOT status flow (kitchen_staff).
- KOT print / ticket layout.

---

## M3 — Public booking + Payments + Notifications

**Epic M3-A Public booking**
- `(public)` route group + public availability service (tenant pinned by subdomain).
- `/book` flow UI (resource type → date → duration → times → details).
- Find-or-create customer by phone on the public path (no login).
- QR generation + `/b/{number}` confirmation page + staff check-in scan.
- Rate-limiting + bot protection on public endpoints.

**Epic M3-B Payments gateway (Razorpay)**
- Migration: `payment_settings` (encrypted per-tenant keys) + settings UI.
- Razorpay order creation for deposits (tenant keys).
- `/api/webhooks/razorpay`: signature verify + idempotent `payments` record.
- Deposit paid → balance-due tracked to in-venue settlement.

**Epic M3-C Notifications**
- Migration: `notification_settings`, `notifications` (outbox) + RLS.
- SMS provider integration (India DLT templates).
- Booking confirmation + reminder messages; retry on failure.

---

## M4 — Employee Management

**Epic M4-A Attendance** — `attendance` table; clock in/out; manual entry; today view.
**Epic M4-B Shifts & Roster** — `shifts`, `rosters`; weekly roster builder + assignment.
**Epic M4-C Tasks** — `tasks` CRUD; assign; status lifecycle.
**Epic M4-D Performance** — derived metrics (sales via `payments.collected_by`, bookings via `bookings.created_by`) dashboard.

---

## M5 — Membership & Wallet

**Epic M5-A Plans** — `membership_plans` CRUD (price, duration, benefits).
**Epic M5-B Customer memberships** — `customer_memberships`; purchase, activate, expiry; benefits (discounts/free hours/credits) feed pricing.
**Epic M5-C Wallet & loyalty** — wallet top-up/debit at POS; loyalty earn/redeem rules.

---

## M6 — Reports & Analytics

**Epic M6-A Revenue & bookings** — daily revenue, bookings, occupancy, peak hours, most-used resource.
**Epic M6-B Food & membership sales** — item sales, membership sales.
**Epic M6-C Employee analytics** — sales/bookings per staff, attendance summary.
**Epic M6-D Reporting infra** — pre-aggregation / materialized views, date-range filters, CSV export.

---

## M7 — Production Hardening (partly continuous)

**Epic M7-A Security & Compliance**
- Full RLS audit (every table has a policy; no gaps) + automated policy test.
- Rate-limiting (public booking, login, webhooks); brute-force lockout.
- Session/CSRF hardening review; secure cookie flags in prod.
- Per-tenant secret encryption review (Razorpay keys); master-key rotation plan.
- `audit_log` coverage for refunds, role changes, deletions, key changes.
- Dependency & container scanning; security headers/CSP.

**Epic M7-B Infra & CI/CD**
- Vercel project + apex domain + **wildcard `*.arenaos.app` TLS**.
- Neon (or managed PG): pooled conn for `arena_app`, direct for migrations.
- Migrations-in-CI (forward-only, guarded); `bootstrap.sql` runbook per env.
- Staging environment; preview deploys; env/secrets management.

**Epic M7-C Observability**
- Sentry (errors), structured request logging.
- Webhook delivery + notification-outbox monitoring.
- Uptime checks + alerting; health endpoint.

**Epic M7-D Performance**
- Index review per access path; N+1 audit; query budgets.
- Load test (booking board, availability, POS); connection-pool tuning.
- Caching where safe (static tenant config).

**Epic M7-E Data & Backups**
- PITR backups + **restore drill**; retention policy.
- Tenant data export + hard-delete (privacy).
- Seed/fixtures for staging.

**Epic M7-F Docs & Runbooks**
- Ops runbook, incident playbook, tenant onboarding SOP, on-call basics.

---

## M8 — Launch / Go-live

**Epic M8-A Go-live**
- Production provisioning + first real tenant onboarding (admin-created).
- DNS cutover; production smoke-test suite.
- Rollback plan rehearsed; support/intake process live.
- Post-launch monitoring window + triage rota.

---

## Continuous workstreams (labels, not milestones)

- **QA/Testing:** grow `verify-*.ts` per invariant; add E2E (Playwright) for
  critical flows (login, book, bill, pay, KOT).
- **Accessibility & responsiveness:** keyboard, contrast, mobile POS/kitchen.
- **i18n / currency:** groundwork only (INR/en-IN now).

## Deferred (post-MVP-1)

Self-serve tenant signup + **SaaS subscription billing of tenants**; customer
accounts/portal & login; **full multi-branch** (switcher, per-branch reports);
custom tenant domains; websocket real-time; multi-currency; loyalty tiers;
inventory/stock management.

---

## Ticket taxonomy

- **Type:** `epic` · `feature` · `chore` · `bug` · `spike`.
- **Milestone:** `M0`…`M8`.
- **Area:** `tenancy` `auth` `booking` `pos` `customers` `food` `kitchen`
  `payments` `notifications` `staff` `membership` `reports` `infra` `security`
  `observability` `docs`.
- **Priority:** `P0` (blocker) `P1` `P2`.
- **Size:** `S` (<½d) · `M` (~1–2d) · `L` (3d+, consider splitting).

Each epic becomes a tracking ticket; each story a `feature`/`chore` ticket
linked to its epic, carrying acceptance criteria (from Definition of Done + the
milestone exit gate).
