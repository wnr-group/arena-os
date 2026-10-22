-- ============================================================================
-- Arena OS — 0151 Walk-in waitlist (M20 / AROS-177)
--
-- Additive only. A per-branch queue of walk-in parties waiting for a table:
-- name, optional phone, party size, quoted wait, and a status that moves
-- waiting -> notified -> seated | left. Seating from the waitlist opens the
-- normal M17 table session (seatTableSessionCore) and links it via booking_id.
--
-- Notifications reuse the M3 `notifications` outbox (kind 'waitlist_ready');
-- no SMS provider exists yet (AROS-52/53/54), so a send is recorded as
-- 'skipped' / not_configured and the host uses the click-to-chat link.
--
-- Default OFF: reservation_settings.waitlist_enabled. module.waitlist
-- entitlement is Pro/Enterprise.
-- ============================================================================

alter table public.reservation_settings
  add column if not exists waitlist_enabled boolean not null default false;

create table if not exists public.waitlist_entries (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  branch_id           uuid not null references public.branches(id) on delete cascade,
  name                text not null check (length(btrim(name)) > 0),
  -- E.164 (lib/customers/phone.ts); optional — a walk-in may not give one.
  phone               text,
  party_size          integer not null check (party_size > 0),
  -- What the host told the guest at the door, minutes.
  quoted_wait_minutes integer check (quoted_wait_minutes is null or quoted_wait_minutes between 0 and 600),
  notes               text,
  status              text not null default 'waiting'
                        check (status in ('waiting', 'notified', 'seated', 'left')),
  created_by          uuid references public.memberships(id) on delete set null,
  created_at          timestamptz not null default now(),
  notified_at         timestamptz,
  seated_at           timestamptz,
  left_at             timestamptz,
  -- The table session this party became (set when seated).
  booking_id          uuid references public.bookings(id) on delete set null
);

create index if not exists idx_waitlist_active
  on public.waitlist_entries(tenant_id, branch_id, created_at)
  where status in ('waiting', 'notified');

alter table public.waitlist_entries enable row level security;

drop policy if exists waitlist_entries_select on public.waitlist_entries;
create policy waitlist_entries_select on public.waitlist_entries
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Front-of-house roles manage the queue (same set as walk-ins / reservations).
-- Each command is its own policy; UPDATE is spelled out so SELECT … FOR UPDATE
-- matches rows (AROS-183).
drop policy if exists waitlist_entries_insert on public.waitlist_entries;
create policy waitlist_entries_insert on public.waitlist_entries
  for insert with check (
    public.auth_role_in(tenant_id) in ('owner','manager','cashier','receptionist','floor_staff')
  );

drop policy if exists waitlist_entries_update on public.waitlist_entries;
create policy waitlist_entries_update on public.waitlist_entries
  for update using (public.auth_role_in(tenant_id) in ('owner','manager','cashier','receptionist','floor_staff'))
          with check (public.auth_role_in(tenant_id) in ('owner','manager','cashier','receptionist','floor_staff'));

drop policy if exists waitlist_entries_delete on public.waitlist_entries;
create policy waitlist_entries_delete on public.waitlist_entries
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.waitlist_entries to arena_app;

-- Pro/Enterprise on, Starter off; a plan with no row is denied (fail-closed).
insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.waitlist',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
