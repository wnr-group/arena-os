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
| | | *— MVP-2 (post-launch; label `mvp2`) —* | |
| **M9** | Customer Accounts & Portal | Phone/OTP login, self-service portal, loyalty tiers | Customer logs in (OTP) → sees history → rebooks; tier derived from points |
| **M10** | Platform Capabilities | Real-time board/kitchen, inventory, multi-currency + i18n | Live updates <~1s; stock deducts on sale; money in tenant currency |
| **M11** | Payroll & Salary | Salary structures, advances, payroll runs + payslips | Run a period → attendance-driven payslips; staff sees own payslip |
| **M12** | Expense Tracker | Expenses, recurring, receipts, P&L | P&L = revenue − expenses − payroll reconciles on seeded data |

**M0–M8 = MVP-1** (the production launch). **M9–M12 = MVP-2** (post-launch),
already ticketed in Jira (epics AROS-83…86). MVP-2 milestones depend on MVP-1
modules — see the dependency notes in each section below; don't start a blocked
story before its dependency ships.

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

# MVP-2 (post-launch)

Ticketed in Jira as epics **AROS-83…86** (label `mvp2`). Build after MVP-1 ships;
respect the **Depends on** notes.

## M9 — Customer Accounts & Portal  (AROS-83)

**Depends on:** M1 Customers · M3 public booking + SMS. Turns the account-less
hybrid booking into real customer accounts.
- Customer **OTP auth** (`customer_sessions`; OTP via M3 SMS) — separate surface from staff/platform.
- Portal shell + guard (`/account` on the tenant subdomain).
- Booking history + upcoming; self-service **rebook/cancel** (policy-gated).
- Profile & preferences; wallet & loyalty balance view.
- **Loyalty tiers** (`loyalty_tiers`, tier derived from the M1 points ledger).

## M10 — Platform Capabilities  (AROS-84)

**Depends on:** M0 booking, M2 food/kitchen, tenant `currency`. Cross-cutting upgrades.
- **Real-time** transport (WS/SSE, tenant-scoped) → live booking board + live kitchen queue (replaces polling).
- **Inventory:** `stock_items` + `stock_movements` (ledger); link menu items → stock, auto-deduct on sale; stock UI + low-stock alerts.
- **Multi-currency** (per-tenant, no FX) end-to-end; **i18n** scaffolding (locale, catalog, RTL).

## M11 — Payroll & Salary  (AROS-85)

**Depends on:** M4 Employee Management (attendance/shifts).
- `salary_structures` (base + allowances + deductions); employee advances/loans.
- **Payroll run** → `payslips` computed from structure + M4 attendance; snapshotted, idempotent per period.
- Payslip view/export (owner + self-service); payroll cost report (feeds M12 P&L).

## M12 — Expense Tracker  (AROS-86)

**Depends on:** M1 (revenue) + M11 (payroll) for the P&L; the model/entry stories are standalone.
- `expense_categories`, `vendors`, `expenses`; entry + list/filter UI; receipt upload.
- Recurring expenses (auto-generation).
- **Expense + P&L report** = revenue (M1 invoices) − expenses − payroll (M11), via the security-barrier view pattern (AROS-64).

---

## Continuous workstreams (labels, not milestones)

- **QA/Testing:** grow `verify-*.ts` per invariant; add E2E (Playwright) for
  critical flows (login, book, bill, pay, KOT).
- **Accessibility & responsiveness:** keyboard, contrast, mobile POS/kitchen.
- **i18n / currency:** groundwork only (INR/en-IN now).

## Deferred (beyond MVP-2)

Still parked (not yet ticketed):
- Self-serve tenant signup + **SaaS subscription billing of tenants** (plan tiers, gating, tenant-billing gateway).
- **Full multi-branch** — branch switcher, per-branch staff/resources/reports, cross-branch owner views.
- **Custom tenant domains** (`tenant_domains` + Vercel Domains API + TLS).

*(Previously listed here and now promoted to MVP-2: customer accounts/portal & loyalty tiers → M9; websocket real-time, inventory, multi-currency + i18n → M10. Payroll → M11 and expense tracker → M12 were added as new MVP-2 epics.)*

---

## Ticket taxonomy

- **Type:** `epic` · `feature` · `chore` · `bug` · `spike`.
- **Milestone:** `M0`…`M8` (MVP-1) · `M9`…`M12` (MVP-2, also labelled `mvp2`).
- **Area:** `tenancy` `auth` `booking` `pos` `customers` `food` `kitchen`
  `payments` `notifications` `staff` `membership` `reports` `infra` `security`
  `observability` `docs`.
- **Priority:** `P0` (blocker) `P1` `P2`.
- **Size:** `S` (<½d) · `M` (~1–2d) · `L` (3d+, consider splitting).

Each epic becomes a tracking ticket; each story a `feature`/`chore` ticket
linked to its epic, carrying acceptance criteria (from Definition of Done + the
milestone exit gate).
