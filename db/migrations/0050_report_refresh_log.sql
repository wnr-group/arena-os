-- ============================================================================
-- Arena OS — 0050 report refresh log (AROS-184 follow-up)
--
-- ── The problem this closes ─────────────────────────────────────────────────
--
-- The P&L (lib/reports/pnl.ts) subtracts LIVE figures from a STALE one:
--
--   revenue   public.v_daily_revenue, over the mv_daily_revenue snapshot (0043)
--   expenses  public.expenses, read live
--   payroll   public.payslips,  read live
--
-- so `netProfit` is understated by every invoice raised since the last refresh.
-- The page has always said revenue "comes from a pre-aggregated snapshot", but
-- a manager could not tell whether that snapshot was five minutes or five weeks
-- old — and the wrongness lands in the profit line, which is the number they
-- act on.
--
-- 0043 recorded "There is no scheduler in this project yet; the ops entry point
-- is scripts/refresh-reports.ts". That is still true, and this migration does
-- NOT invent one. What it does is make the staleness MEASURABLE, so the report
-- can state its own age instead of implying freshness it does not have.
--
-- ── Why a table rather than asking Postgres ─────────────────────────────────
--
-- Postgres does not record when a materialized view was last refreshed.
-- pg_stat_all_tables timestamps track autovacuum/autoanalyze, not REFRESH, and
-- would silently answer a different question. One row, stamped by the refresh
-- function itself, is the only honest source.
--
-- ── Why this table carries no tenant_id and no RLS ──────────────────────────
--
-- A refresh is a whole-database operation: mv_daily_revenue is rebuilt for
-- every tenant at once, so "when was it last rebuilt" is one global fact, not a
-- per-tenant one. There is nothing here to scope — the row holds a view name
-- and a timestamp, no tenant data of any kind — so a tenant session reading it
-- learns only how fresh its own report is. Writing stays shut: INSERT/UPDATE is
-- never granted to arena_app, and the only writer is the SECURITY DEFINER
-- refresh function below, which arena_app already cannot execute (0043).
-- ============================================================================

create table if not exists public.report_refresh_log (
  -- The materialized view this row describes, e.g. 'mv_daily_revenue'.
  view_name    text primary key,
  refreshed_at timestamptz not null default now()
);

comment on table public.report_refresh_log is
  'When each reporting materialized view was last refreshed. One global row per view; no tenant data, deliberately un-scoped by RLS. Written only by the SECURITY DEFINER refresh functions.';

-- Read-only for the app role: it needs the timestamp to render "last refreshed
-- N hours ago", and can do nothing else with it.
revoke all on public.report_refresh_log from public;
grant select on public.report_refresh_log to arena_app;

-- ── stamp the refresh ───────────────────────────────────────────────────────
-- Same body as 0043 plus the stamp, so the log cannot drift from the thing it
-- describes: there is no path that refreshes the view without recording it.
--
-- clock_timestamp(), not now(): now() is the transaction's START time, and a
-- CONCURRENTLY refresh over a large invoice table can run for a while. The
-- useful figure is when the snapshot became current, which is the end.
create or replace function public.refresh_daily_revenue()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  refresh materialized view concurrently public.mv_daily_revenue;

  insert into public.report_refresh_log (view_name, refreshed_at)
  values ('mv_daily_revenue', clock_timestamp())
  on conflict (view_name) do update set refreshed_at = excluded.refreshed_at;
end;
$$;

revoke all on function public.refresh_daily_revenue() from public;

-- Seed a row so an existing database reports "unknown" rather than nothing at
-- all before its next refresh. Deliberately NOT stamped with now(): the view
-- was last refreshed at some unknown past time, and claiming otherwise would
-- be the exact false-freshness this migration exists to remove.
insert into public.report_refresh_log (view_name, refreshed_at)
values ('mv_daily_revenue', 'epoch'::timestamptz)
on conflict (view_name) do nothing;
