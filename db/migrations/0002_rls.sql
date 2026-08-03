-- ============================================================================
-- Arena OS — 0002 RLS: identity source, helper functions, policies, grants
--
-- Isolation model in plain Postgres:
--   * The app connects as role `arena_app` (no BYPASSRLS, not a table owner) and
--     sets `app.user_id` per transaction. RLS therefore applies to every query.
--   * The owner role (arena_owner) owns these tables and is exempt from RLS,
--     which is exactly what provisioning/seeding/auth need. RLS is intentionally
--     NOT forced, so the owner path can manage rows freely.
-- ============================================================================

-- The current user id, read from the transaction-local GUC set by withUser().
-- missing_ok => returns NULL when unset, so an unauthenticated app connection
-- resolves to "no tenants" rather than erroring.
create or replace function public.current_app_user_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- Tenants the current user is an ACTIVE member of.
-- SECURITY DEFINER (owner) lets this read memberships without tripping the RLS
-- on memberships itself — avoids recursion, and cannot leak because it filters
-- strictly by the caller's own user id.
create or replace function public.auth_tenant_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select tenant_id from public.memberships
  where user_id = public.current_app_user_id() and status = 'active';
$$;

create or replace function public.auth_role_in(p_tenant uuid)
returns public.member_role
language sql stable security definer set search_path = public
as $$
  select role from public.memberships
  where user_id = public.current_app_user_id()
    and tenant_id = p_tenant and status = 'active'
  limit 1;
$$;

create or replace function public.auth_is_manager(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.auth_role_in(p_tenant) in ('owner','manager'), false);
$$;

-- ── enable RLS + policies ────────────────────────────────────────────────────
alter table public.tenants     enable row level security;
alter table public.branches    enable row level security;
alter table public.memberships enable row level security;

drop policy if exists tenants_member_select on public.tenants;
create policy tenants_member_select on public.tenants
  for select using (id in (select public.auth_tenant_ids()));

drop policy if exists tenants_owner_update on public.tenants;
create policy tenants_owner_update on public.tenants
  for update using (public.auth_role_in(id) = 'owner')
             with check (public.auth_role_in(id) = 'owner');

drop policy if exists branches_member_select on public.branches;
create policy branches_member_select on public.branches
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists branches_manager_write on public.branches;
create policy branches_manager_write on public.branches
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists memberships_member_select on public.memberships;
create policy memberships_member_select on public.memberships
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists memberships_manager_write on public.memberships;
create policy memberships_manager_write on public.memberships
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- ── grants to the app role ───────────────────────────────────────────────────
-- arena_app may touch tenant tables (subject to RLS) but NOT users/sessions.
grant usage on schema public to arena_app;
grant select, insert, update, delete on public.tenants     to arena_app;
grant select, insert, update, delete on public.branches    to arena_app;
grant select, insert, update, delete on public.memberships to arena_app;
grant execute on function public.current_app_user_id()      to arena_app;
grant execute on function public.auth_tenant_ids()          to arena_app;
grant execute on function public.auth_role_in(uuid)         to arena_app;
grant execute on function public.auth_is_manager(uuid)      to arena_app;

-- Explicitly ensure the app role can never read identity tables.
revoke all on public.users    from arena_app;
revoke all on public.sessions from arena_app;

-- ============================================================================
-- Template for every future business table:
--
--   create table public.<name> (
--     id uuid primary key default gen_random_uuid(),
--     tenant_id uuid not null references public.tenants(id) on delete cascade,
--     branch_id uuid references public.branches(id) on delete set null,
--     ... );
--   alter table public.<name> enable row level security;
--   create policy <name>_member_rw on public.<name> for all
--     using (tenant_id in (select public.auth_tenant_ids()))
--     with check (tenant_id in (select public.auth_tenant_ids()));
--   grant select, insert, update, delete on public.<name> to arena_app;
--
-- tenant_id is NEVER nullable on a business table.
-- ============================================================================
