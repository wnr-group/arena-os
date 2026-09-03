-- ============================================================================
-- Arena OS — 0084 fix infinite recursion in the event team policies
--
-- A CORRECTNESS FIX to 0079 (M15 #3), found while building day-of check-in
-- (M15 #5). Not a feature.
--
-- ══ THE BUG ═════════════════════════════════════════════════════════════════
--
-- 0079 gave `event_team_members` two policies that read `event_team_members`:
--
--     event_team_members_customer_select
--     event_team_members_customer_isolation
--       … EXISTS (select 1 from public.event_team_members mine
--                  where mine.team_id = event_team_members.team_id
--                    and mine.customer_id = current_customer_id())
--
-- Evaluating that policy requires reading the table, which applies the policy,
-- which requires reading the table. Postgres detects it during rewrite and
-- raises, so it fires for EVERY caller regardless of whether a customer session
-- is set — the `current_customer_id() is null` short-circuit never gets a
-- chance to run, because the recursion is found while the query is being
-- rewritten, not while it is being executed.
--
-- `event_teams` inherits the failure: its own customer policies reference
-- `event_team_members`, so reading a TEAM recurses too.
--
-- Reproduced before this migration, as arena_app with a staff session:
--
--     select count(*) from event_teams;
--     ERROR:  infinite recursion detected in policy for relation "event_team_members"
--
-- ══ WHAT IT BROKE ═══════════════════════════════════════════════════════════
--
-- Every staff-side read that joins `event_teams` — which is the manager's
-- entrants list (listEventEntrants, the one surface a team event's organiser
-- actually uses) and, from M15 #5, the check-in scan and the checked-in list.
-- Any team registration read on the app connection was affected. The existing
-- suites did not catch it because they drive the SECURITY DEFINER registration
-- functions, which run as owner and bypass RLS entirely.
--
-- ══ THE FIX — the pattern 0002 already established ══════════════════════════
--
-- 0002 hit this exact problem with `memberships` and solved it with a
-- SECURITY DEFINER helper: `auth_tenant_ids()` reads memberships as owner, so
-- the policy that needs it does not re-enter the table. Its comment says so in
-- as many words — "SECURITY DEFINER to read memberships without recursion".
--
-- Same shape here. `customer_team_ids()` answers "which teams is the current
-- customer in?" as owner, and the four policies test membership against its
-- result instead of re-querying the table.
--
-- This changes NO access decision. The predicate is the same set it was before;
-- it is merely computed somewhere that does not recurse. A customer still sees
-- exactly their own teams and their own team-mates, and a staff member still
-- sees their tenant's rows through the unchanged `_select` policies.
-- ============================================================================

-- The current customer's teams, read as owner so a policy may call it safely.
-- STABLE, so it is evaluated once per statement rather than per row.
--
-- Returns nothing when there is no customer session, which is what makes the
-- `is null` short-circuits below correct AND cheap: a staff query gets an empty
-- set and the EXISTS collapses immediately.
create or replace function public.customer_team_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select m.team_id
    from public.event_team_members m
   where public.current_customer_id() is not null
     and m.customer_id = public.current_customer_id();
$$;

revoke all on function public.customer_team_ids() from public;
grant execute on function public.customer_team_ids() to arena_app;

comment on function public.customer_team_ids() is
  'Teams the current OTP-session customer belongs to. SECURITY DEFINER so the event_teams / event_team_members policies can test membership without re-entering the table they guard — the same reason auth_tenant_ids() exists for memberships (0002). Added by 0084 to fix the recursion 0079 introduced.';

-- ── event_team_members ──────────────────────────────────────────────────────
drop policy if exists event_team_members_customer_select on public.event_team_members;
create policy event_team_members_customer_select on public.event_team_members
  for select using (
    tenant_id = public.current_customer_tenant_id()
    and team_id in (select public.customer_team_ids())
  );

drop policy if exists event_team_members_customer_isolation on public.event_team_members;
create policy event_team_members_customer_isolation on public.event_team_members
  as restrictive for all
  using (
    public.current_customer_id() is null
    or team_id in (select public.customer_team_ids())
  )
  with check (
    public.current_customer_id() is null
    or team_id in (select public.customer_team_ids())
  );

-- ── event_teams ─────────────────────────────────────────────────────────────
-- These did not recurse on their own, but they reached INTO the recursive
-- table, so they inherited the failure. Rewritten against the same helper.
drop policy if exists event_teams_customer_select on public.event_teams;
create policy event_teams_customer_select on public.event_teams
  for select using (
    tenant_id = public.current_customer_tenant_id()
    and id in (select public.customer_team_ids())
  );

drop policy if exists event_teams_customer_isolation on public.event_teams;
create policy event_teams_customer_isolation on public.event_teams
  as restrictive for all
  using (
    public.current_customer_id() is null
    or id in (select public.customer_team_ids())
  )
  with check (
    public.current_customer_id() is null
    or id in (select public.customer_team_ids())
  );
