-- ============================================================================
-- Arena OS — 0043 reporting infrastructure (AROS-64)
--
-- The shape every M6 report (AROS-65/66/67) is meant to reuse:
--
--     source tables (invoices …)
--            ↓  pre-aggregation, refreshed out of band
--     public.mv_daily_revenue        ← NEVER queried by the app
--            ↓  security_barrier + auth_tenant_ids()
--     public.v_daily_revenue         ← the ONLY thing arena_app may read
--            ↓  tenant + date filtered
--     the report query (lib/reports/daily-revenue.ts)
--
-- WHY THE TWO LAYERS. A materialized view is not a table: the RLS policies on
-- `invoices` do not carry into it, and `alter … enable row level security` is
-- not available on it either. Left alone, one SELECT on the MV would return
-- every tenant's revenue. Isolation is therefore restored by a barrier view
-- that re-applies auth_tenant_ids() — the same predicate every business-table
-- policy uses (0002_rls.sql) — plus grants: arena_app gets SELECT on the view
-- and never on the MV behind it. A view runs with its OWNER's privileges
-- (security_invoker = false, the default), so the view can read an MV the
-- caller itself cannot touch. That is precisely the guarantee we want.
-- ============================================================================

-- ── daily revenue aggregate ─────────────────────────────────────────────────
-- Grain: one row per (tenant, branch, local calendar day).
--
--   gross    = SUM(subtotal)   discount = SUM(discount)
--   tax      = SUM(tax_total)  net      = SUM(total)
--
-- Only invoices that represent real money are counted: 'issued' (raised, maybe
-- still unpaid) and 'paid'. 'draft' is not a bill yet and 'void' has been
-- struck off; excluding both is what makes `net` reconcile against
-- invoices.total for the same filter.
--
-- `day` is the calendar day on the BRANCH's wall clock — branches.timezone
-- when set, else the tenant's — never the server's. The session TimeZone is
-- UTC here, so a bare date_trunc('day', issued_at) would push every IST sale
-- after 05:30 local into the previous day's bucket and make a "today" report
-- silently wrong. This mirrors how the rest of the app already handles dates
-- (lib/booking/time.ts: todayInZone / zonedTimeToUtc).
--
-- Invoices with a NULL issued_at are skipped: they cannot be placed on a day,
-- and NULLs are distinct to a unique index, which would break the CONCURRENTLY
-- refresh below. Every path that leaves 'draft' stamps issued_at
-- (lib/billing/invoice.ts), so in practice this excludes nothing.
create materialized view if not exists public.mv_daily_revenue as
  select
    i.tenant_id,
    i.branch_id,
    (i.issued_at at time zone coalesce(b.timezone, t.timezone))::date as day,
    sum(i.subtotal)::numeric(14,2)  as gross,
    sum(i.discount)::numeric(14,2)  as discount,
    sum(i.tax_total)::numeric(14,2) as tax,
    sum(i.total)::numeric(14,2)     as net,
    count(*)::integer               as invoice_count
  from public.invoices i
  join public.tenants  t on t.id = i.tenant_id
  join public.branches b on b.id = i.branch_id
  where i.status in ('issued','paid')
    and i.issued_at is not null
  group by i.tenant_id, i.branch_id,
           (i.issued_at at time zone coalesce(b.timezone, t.timezone))::date;

-- REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY, and also the access
-- path for a single-branch report: (tenant_id, branch_id, day).
create unique index if not exists mv_daily_revenue_key
  on public.mv_daily_revenue (tenant_id, branch_id, day);

-- The all-branches date-range scan: leading tenant_id (the isolation
-- predicate) then day (the filter), so a range is one index scan.
create index if not exists idx_mv_daily_revenue_tenant_day
  on public.mv_daily_revenue (tenant_id, day);

-- ── the tenant-safe read surface ────────────────────────────────────────────
-- security_barrier so a cheap-but-leaky user function in a caller's WHERE
-- clause cannot be evaluated before the tenant predicate and sniff rows from
-- another tenant.
--
-- Role is deliberately NOT filtered here. Tenant isolation is a database
-- guarantee; "reports are owner/manager" (ARCHITECTURE.md §3) is a product
-- rule enforced in the reader and the page, exactly as the existing employee
-- report does (lib/reports/employees.ts + app/(app)/reports/employees/page.tsx).
-- Baking the role into shared infrastructure would also pre-judge AROS-65/66/67,
-- which may legitimately want a till summary for the cashier who rang it.
create or replace view public.v_daily_revenue
  with (security_barrier = true, security_invoker = false) as
  select
    m.tenant_id,
    m.branch_id,
    m.day,
    m.gross,
    m.discount,
    m.tax,
    m.net,
    m.invoice_count
  from public.mv_daily_revenue m
  where m.tenant_id in (select public.auth_tenant_ids());

-- ── refresh ─────────────────────────────────────────────────────────────────
-- CONCURRENTLY keeps the view readable while it rebuilds (it requires the
-- unique index above). It cannot run inside a transaction block, so it is NOT
-- called here — CREATE MATERIALIZED VIEW populates it. There is no scheduler
-- in this project yet; the ops entry point is scripts/refresh-reports.ts, run
-- as the owner role. See docs/ARCHITECTURE.md → Reporting.
--
-- SECURITY DEFINER so a future job runner can be granted execute without
-- owning the MV. Nothing is granted today: refreshing is an owner-level,
-- whole-database operation and no tenant session has any business triggering
-- one (it would also be a cheap way to load the database).
create or replace function public.refresh_daily_revenue()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  refresh materialized view concurrently public.mv_daily_revenue;
end;
$$;

revoke all on function public.refresh_daily_revenue() from public;

-- ── grants ──────────────────────────────────────────────────────────────────
-- The whole isolation argument in two lines: the app role may read the barrier
-- view, and may NOT read the materialized view underneath it.
revoke all on public.mv_daily_revenue from arena_app;
grant select on public.v_daily_revenue to arena_app;
