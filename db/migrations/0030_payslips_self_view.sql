-- ============================================================================
-- Arena OS — 0030 payslips self-view: staff see their own payslips, owner and
-- manager see everyone's (AROS-105, M11 fourth ticket — builds on
-- 0029_payroll_runs.sql).
--
-- 0029 made payslips owner-only for both read and write, matching
-- salary_structures/employee_advances (compensation is sensitive). This
-- ticket widens SELECT only: "My Payslips" is self-service for every staff
-- member, and owner/manager can look up anyone's — a deliberate, ticket-level
-- decision to treat a payslip more like attendance (self visible to the
-- person it's about) than like the salary_structures it's computed from.
-- INSERT stays owner-only: only the payroll run writes these, unchanged from
-- 0029.
--
-- auth_membership_id() is the new primitive this needs: "the caller's own
-- membership row in this tenant", same SECURITY DEFINER shape as
-- auth_role_in()/auth_is_manager() (0002_rls.sql) — it has to read
-- memberships without tripping that table's own RLS, and cannot leak because
-- it filters strictly by the caller's own user id.
--
-- Two permissive SELECT policies (self + manager) combine with OR: a plain
-- staff member matches only payslips_self_select and sees their own rows; an
-- owner or manager matches payslips_manager_select and sees every row in the
-- tenant, including their own.
-- ============================================================================

create or replace function public.auth_membership_id(p_tenant uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.memberships
  where user_id = public.current_app_user_id()
    and tenant_id = p_tenant and status = 'active'
  limit 1;
$$;
grant execute on function public.auth_membership_id(uuid) to arena_app;

drop policy if exists payslips_owner_rw on public.payslips;

drop policy if exists payslips_self_select on public.payslips;
create policy payslips_self_select on public.payslips
  for select using (membership_id = public.auth_membership_id(tenant_id));

drop policy if exists payslips_manager_select on public.payslips;
create policy payslips_manager_select on public.payslips
  for select using (public.auth_is_manager(tenant_id));

drop policy if exists payslips_owner_insert on public.payslips;
create policy payslips_owner_insert on public.payslips
  for insert with check (public.auth_role_in(tenant_id) = 'owner');

-- Grants are unchanged from 0029 (select, insert) — restated for clarity,
-- since which ROWS are visible is now entirely the policies' job above.
grant select, insert on public.payslips to arena_app;
