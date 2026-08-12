# Arena OS

Multi-tenant **Smart Booking & POS platform**. One codebase, one PostgreSQL
database, many businesses — each on its own subdomain, isolated by Postgres
Row-Level Security. Built for gaming cafes, recording/podcast/dance studios and
VR centres.

**Status:** the foundation (**M0**) is built and verified — multi-tenant auth,
platform admin, staff/team management, the generic resource model and the booking
engine. Everything else (Customers, POS/GST, Food/KOT, Membership, Reports, public
booking) is designed and ticketed but not yet implemented. See **Docs** below and
`docs/ROADMAP.md`.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL 17 ·
Drizzle ORM · Tailwind v4 · argon2 (auth). No Supabase, no external auth service.

---

## Prerequisites

- **Node 20+** and npm 10+
- **Docker** (easiest — used for the local Postgres) _or_ a local PostgreSQL 17
  with superuser access.

---

## Quickstart (Docker — recommended)

From the repo root:

```bash
# 1. Install deps
npm install

# 2. Start a local Postgres 17
docker run -d --name arena_pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:17-alpine

# 3. Create the database + the two app roles (arena_owner, arena_app)
docker exec arena_pg psql -U postgres -c "create database arena_os"
docker exec -i arena_pg psql -U postgres -d arena_os -v ON_ERROR_STOP=1 < db/bootstrap.sql
docker exec arena_pg psql -U postgres -d arena_os -c "alter database arena_os owner to arena_owner"

# 4. Env file (points at the container on port 5433)
cp .env.example .env.local
#   For local Docker the default values in .env.example already match the
#   passwords in db/bootstrap.sql — just set a SESSION_SECRET:
#     openssl rand -hex 32   → paste into SESSION_SECRET in .env.local

# 5. Apply migrations, then seed demo data
npm run db:migrate
npm run seed:demo

# 6. Run it
npm run dev
```

Open **http://demo.lvh.me:3000/login** and sign in (credentials below).
`lvh.me` resolves `*.lvh.me` → `127.0.0.1`, so subdomains work locally with no
`/etc/hosts` edits.

> **Native Postgres instead of Docker?** Run `createdb arena_os`,
> `psql -d arena_os -f db/bootstrap.sql`, `psql -d arena_os -c "alter database arena_os owner to arena_owner"`,
> then set `DATABASE_URL`/`DATABASE_URL_OWNER` in `.env.local` to your host/port
> and continue from step 5. Change the role passwords in `db/bootstrap.sql` for
> anything but local dev.

---

## Seeded logins

`npm run seed:demo` creates one platform admin and a demo company with three staff
roles. **Local dev only — do not use these anywhere real.**

| Role | URL | Email | Password |
|---|---|---|---|
| **Platform admin** (operates Arena OS; manages companies) | http://lvh.me:3000/login | `admin@arenaos.test` | `admin1234` |
| **Company owner** (runs the demo company) | http://demo.lvh.me:3000/login | `owner@demo.test` | `demo1234` |
| **Company manager** | http://demo.lvh.me:3000/login | `manager@demo.test` | `demo1234` |
| **Company cashier** | http://demo.lvh.me:3000/login | `cashier@demo.test` | `demo1234` |

The seed is **idempotent** — re-run it any time to reset these accounts and demo
resources. Create more companies live from the platform admin panel (`/admin`).

### What to try
- **Platform admin** (`lvh.me:3000/admin`): list/create/manage companies, provision
  owners, change company status, add/remove members.
- **Company** (`demo.lvh.me:3000`): the **Bookings** daily board (create a walk-in
  booking → pick resource + duration → available times → check-in/complete/cancel;
  overlapping slots are refused), plus **Settings → Resources / Working Hours / Team**.
- Log in as the **cashier** to see reduced navigation (no manager-only settings).

---

## Project layout

```
app/
  (platform)/admin/     Platform admin panel (root domain) — companies, members
  (app)/                Company staff app (tenant subdomains): dashboard, bookings, settings
  (public? later)       Public booking /book lands here (M3)
  login/  page.tsx      Auth entry + root landing
components/             Sidebar, bookings board, settings managers, platform UI
db/
  schema.ts             Drizzle table definitions (typed queries) — mirror of the SQL
  index.ts              pg pools + withUser() (RLS-scoped app connection) + ownerDb
  bootstrap.sql         One-time: create arena_owner + arena_app roles (run as superuser)
  migrations/*.sql      Authoritative schema, applied in order by scripts/migrate.ts
lib/
  auth/                 sessions, password hashing, cookie, role guards
  tenant/               subdomain resolution + getActiveContext()
  booking/              availability engine (pure, timezone-aware) + queries
  actions/              server actions (bookings, resources, team, platform, auth)
  platform/             platform-admin data + provisioning (owner connection)
scripts/                migrate.ts, seed-demo.ts, verify-rls.ts, verify-booking.ts
docs/                   ARCHITECTURE.md, ROADMAP.md, DATA-MODEL.md
proxy.ts                Edge middleware: resolves tenant subdomain, guards routes
```

## Core concepts (read `docs/ARCHITECTURE.md` for the full rationale)

- **Tenancy = shared DB + RLS.** Every business row has `tenant_id`; RLS makes
  cross-tenant access structurally impossible.
- **Two Postgres roles are the boundary.** The app connects as **`arena_app`**
  (no `BYPASSRLS`); every tenant query runs through `db/index.ts:withUser()`,
  which sets `app.user_id` per transaction so RLS scopes each row. **`arena_owner`**
  owns the tables (RLS-exempt) and is used only for migrations, seeding, platform
  provisioning and auth/session lookups.
- **Custom auth:** argon2 hashing, a `sessions` table, an opaque token in an
  httpOnly cookie (only its SHA-256 is stored).
- **Subdomains:** `{slug}.{root-domain}` resolved in `proxy.ts`, read server-side
  by `lib/tenant/context.ts`.
- **Bookings can't double-book:** a GiST exclusion constraint on `booking_slots`
  rejects overlapping active slots on a resource; cancelling frees the time via
  trigger.

## npm scripts

| Command | Does |
|---|---|
| `npm run dev` | Start the dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run type-check` | `tsc --noEmit` |
| `npm run db:migrate` | Apply pending `db/migrations/*.sql` (as `arena_owner`) |
| `npm run seed:demo` | Seed/reset the demo company + logins (idempotent) |
| `npm run db:studio` | Drizzle Studio (schema browser) |

## Migrations & schema workflow

Authoritative schema is **hand-written SQL** in `db/migrations/`, applied in
filename order by `scripts/migrate.ts` (they include roles, functions, RLS
policies and grants that a schema-diff tool can't express). `db/schema.ts` mirrors
the tables for type-safe Drizzle queries — **keep the two in sync**. Every new
business table follows the RLS template at the bottom of `db/migrations/0002_rls.sql`.
Per-table DDL for planned modules lives in `docs/DATA-MODEL.md` and on each Jira
data-model ticket.

## Verifying

```bash
npx tsx scripts/verify-rls.ts       # tenant isolation (reads + writes) via arena_app — 6 assertions
npx tsx scripts/verify-booking.ts   # exclusion constraint, cancel-frees-time trigger, RLS on bookings — 5 assertions
npx tsx scripts/verify-customers.ts # unique(tenant_id,phone), E.164 check, RLS on customers + ledgers,
                                    #   note edit/cascade/cross-tenant FK, and that no balance is ever
                                    #   stored — 30 assertions
npx tsx scripts/test-customers.ts   # findOrCreateCustomer: normalisation, idempotency (incl. concurrent
                                    #   callers), per-tenant identity, isolation — 20 assertions
npx tsx scripts/test-customer-notes.ts # customer notes CRUD (author, timestamps, edited marker) and tag
                                    #   add/remove/de-duplication, all tenant-scoped — 48 assertions
npx tsx scripts/verify-billing.ts   # billing objects (tables/enums/indexes/triggers), db/schema.ts ↔ SQL
                                    #   drift, unique(tenant_id,invoice_number), numeric(10,2) money, RLS
                                    #   on all six tables, manager-only refunds, append-only audit log,
                                    #   composite-FK tenant safety — 72 assertions
npm run type-check && npm run build # must be clean before a PR
```

Add a `verify-*` assertion whenever you introduce a new DB-level invariant.

## Docs

- `docs/ARCHITECTURE.md` — design of record (tenancy, boundaries, surfaces, auth,
  permissions matrix, full data-model map, deployment).
- `docs/ROADMAP.md` — production roadmap: milestones M0–M8, exit gates, launch
  checklist, ticket taxonomy.
- `docs/DATA-MODEL.md` — authoritative column-level schema for **every** table
  (built + planned), with keys, indexes and RLS notes.
- **Issue tracker:** Jira project **AROS** (board 67). Milestone epics AROS-1…9;
  M1 stories carry inline DDL.

## Troubleshooting

- **Subdomain won't load** — use `lvh.me` (or `*.lvh.me`), not `localhost`; it
  resolves to 127.0.0.1 automatically.
- **DB connection refused** — is the container up? `docker ps`. Start it:
  `docker start arena_pg`. Port is **5433** (host) → 5432 (container).
- **`arena_app` permission errors after adding a table** — you forgot the
  `grant … to arena_app` + RLS policy; see the template in `0002_rls.sql`.
- **Reset everything** — `docker rm -f arena_pg`, then redo Quickstart steps 2–5.
