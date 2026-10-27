-- ============================================================================
-- Arena OS — 0156 Tips management: rules, period payouts, payslip line (M20 / AROS-181)
--
-- Additive only. Tip CAPTURE already exists (0089/0090: payments.tip_amount and
-- the optional payments.tip_recipient_membership_id; tips are kept out of
-- invoice totals/revenue). This adds what happens to that money afterwards:
--
--   * tip_settings   per-tenant rules: direct (a server keeps their own) or
--                    pooled (split by hours worked), an optional tip-out % to
--                    chosen roles (kitchen / bar), and who shares the pool.
--   * tip_periods    one row per finalised calendar month: the rules and totals
--                    that were in force, so a later settings change never
--                    rewrites a closed month (frozen snapshot, like payslips).
--   * tip_payouts    the ledger — what each person is owed for a month, with
--                    the breakdown. 'pending' until paid; payroll marks it
--                    'paid' and links the payslip it was added to.
--   * payslips.tip_payout   the tips line on a payslip. It is NOT part of
--                    gross / net_pay / deductions — wage cost, tax maths and
--                    advance recovery are unchanged; tips are paid on top.
--
-- Default: direct mode, 0% tip-out, nothing finalised — a tenant that never
-- opens the Tips screen sees no change. module.tips entitlement: Pro/Enterprise.
-- ============================================================================

-- Lets the ledger prove its person belongs to the same tenant.
create unique index if not exists memberships_tenant_id_id_key on public.memberships(tenant_id, id);

create table if not exists public.tip_settings (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  -- direct: a server keeps the tips left on their tables.
  -- pooled: all tips are summed and split by hours worked.
  mode          text not null default 'direct' check (mode in ('direct', 'pooled')),
  -- Share of tips (per server when direct, of the whole pool when pooled) that
  -- goes to tip_out_roles instead.
  tip_out_pct   numeric(5,2) not null default 0 check (tip_out_pct between 0 and 100),
  -- Roles that share the pool (pooled mode) and the unattributed tips (direct).
  pool_roles    text[] not null default array['floor_staff'],
  -- Roles that receive the tip-out, split by hours worked.
  tip_out_roles text[] not null default array[]::text[],
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.memberships(id) on delete set null,
  -- A role can't be both in the pool and tipped out to.
  constraint tip_settings_roles_disjoint check (not (pool_roles && tip_out_roles))
);

create table if not exists public.tip_periods (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  period          text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- Frozen rules + figures for the month.
  settings        jsonb not null,
  total_tips      numeric(12,2) not null check (total_tips >= 0),
  distributed     numeric(12,2) not null check (distributed >= 0),
  -- Tips nobody could be paid (e.g. a pool with no one clocked in).
  undistributed   numeric(12,2) not null default 0 check (undistributed >= 0),
  finalized_by    uuid references public.memberships(id) on delete set null,
  finalized_at    timestamptz not null default now(),
  primary key (tenant_id, period)
);

create table if not exists public.tip_payouts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  period        text not null,
  membership_id uuid not null,
  amount        numeric(10,2) not null check (amount > 0),
  -- { own, poolShare, tipOutReceived, tippedOut, hours }
  breakdown     jsonb not null default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending', 'paid')),
  payslip_id    uuid references public.payslips(id) on delete set null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint tip_payouts_period_member_key unique (tenant_id, period, membership_id),
  constraint tip_payouts_period_fkey
    foreign key (tenant_id, period) references public.tip_periods(tenant_id, period) on delete cascade,
  constraint tip_payouts_member_fkey
    foreign key (tenant_id, membership_id) references public.memberships(tenant_id, id) on delete cascade
);
create index if not exists idx_tip_payouts_member on public.tip_payouts(tenant_id, membership_id);

alter table public.payslips
  add column if not exists tip_payout numeric(10,2) not null default 0 check (tip_payout >= 0);
comment on column public.payslips.tip_payout is
  'Tips paid out on this payslip (M20). Separate from gross / net_pay: not wage cost, not taxed or used to recover advances here.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.tip_settings enable row level security;
alter table public.tip_periods  enable row level security;
alter table public.tip_payouts  enable row level security;

-- Rules and period totals are management information.
drop policy if exists tip_settings_select on public.tip_settings;
create policy tip_settings_select on public.tip_settings
  for select using (public.auth_is_manager(tenant_id));
drop policy if exists tip_settings_insert on public.tip_settings;
create policy tip_settings_insert on public.tip_settings
  for insert with check (public.auth_is_manager(tenant_id));
drop policy if exists tip_settings_update on public.tip_settings;
create policy tip_settings_update on public.tip_settings
  for update using (public.auth_is_manager(tenant_id)) with check (public.auth_is_manager(tenant_id));

drop policy if exists tip_periods_select on public.tip_periods;
create policy tip_periods_select on public.tip_periods
  for select using (public.auth_is_manager(tenant_id));
drop policy if exists tip_periods_insert on public.tip_periods;
create policy tip_periods_insert on public.tip_periods
  for insert with check (public.auth_is_manager(tenant_id));
drop policy if exists tip_periods_update on public.tip_periods;
create policy tip_periods_update on public.tip_periods
  for update using (public.auth_is_manager(tenant_id)) with check (public.auth_is_manager(tenant_id));
drop policy if exists tip_periods_delete on public.tip_periods;
create policy tip_periods_delete on public.tip_periods
  for delete using (public.auth_is_manager(tenant_id));

-- A staff member can see their OWN tip payouts (like their own payslips,
-- 0030); owner/manager see everyone's.
drop policy if exists tip_payouts_select on public.tip_payouts;
create policy tip_payouts_select on public.tip_payouts
  for select using (
    public.auth_is_manager(tenant_id)
    or membership_id = public.auth_membership_id(tenant_id)
  );
drop policy if exists tip_payouts_insert on public.tip_payouts;
create policy tip_payouts_insert on public.tip_payouts
  for insert with check (public.auth_is_manager(tenant_id));
drop policy if exists tip_payouts_update on public.tip_payouts;
create policy tip_payouts_update on public.tip_payouts
  for update using (public.auth_is_manager(tenant_id)) with check (public.auth_is_manager(tenant_id));
drop policy if exists tip_payouts_delete on public.tip_payouts;
create policy tip_payouts_delete on public.tip_payouts
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update on public.tip_settings to arena_app;
grant select, insert, update, delete on public.tip_periods to arena_app;
grant select, insert, update, delete on public.tip_payouts to arena_app;

-- ── entitlement ─────────────────────────────────────────────────────────────
insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.tips',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
