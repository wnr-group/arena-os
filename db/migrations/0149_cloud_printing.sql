-- ============================================================================
-- Arena OS — 0149 cloud printing: printers + print-job queue (M19 / AROS-175)
--
-- Additive only; numbered after 0148 (renumber at merge).
--
-- TRANSPORT DECISION. The app runs in the cloud (Vercel); printers sit on the
-- venue LAN, so the server can never open a socket to them. We use CLOUD-PRINT:
-- the printer polls an HTTPS endpoint of ours (Star CloudPRNT) and pulls jobs
-- from the tenant-scoped queue below. No agent / bridge to install. The job
-- bytes (ESC/POS) are rendered at enqueue time and stored, so a reprint is
-- byte-identical and the printer endpoint does no business logic.
--
-- The polling endpoint is unauthenticated by session — the device identifies
-- itself with printer id + a secret in its URL (only the SHA-256 is stored).
-- It reaches the data ONLY through the three SECURITY DEFINER functions at the
-- bottom, each re-verifying the secret; the app role gets no broad rights on
-- these tables for that path.
--
-- Opt-in is implicit and per tenant: no active printer for a branch = no job is
-- ever created and the existing browser web-print is the only path.
-- ============================================================================

create table if not exists public.printers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  branch_id    uuid not null references public.branches(id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 40),
  kind         text not null check (kind in ('kitchen','receipt')),
  -- The kitchen printer that takes lines whose station has no printer of its own.
  is_default   boolean not null default false,
  -- Characters per line: 32 (58mm), 42/48 (80mm).
  paper_chars  integer not null default 42 check (paper_chars between 24 and 64),
  -- Offered to the device in the CloudPRNT poll response. Must match the
  -- printer's emulation — confirm in the pilot-venue spike.
  media_type   text not null default 'application/vnd.star.starprnt',
  secret_hash  text not null,
  is_active    boolean not null default true,
  device_mac   text,
  last_seen_at timestamptz,
  last_status  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists printers_tenant_name_key
  on public.printers(tenant_id, lower(btrim(name)));
create index if not exists idx_printers_branch on public.printers(tenant_id, branch_id, kind) where is_active;

drop trigger if exists trg_printers_updated on public.printers;
create trigger trg_printers_updated before update on public.printers
  for each row execute function public.set_updated_at();

alter table public.printers enable row level security;
drop policy if exists printers_select on public.printers;
create policy printers_select on public.printers
  for select using (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists printers_insert on public.printers;
create policy printers_insert on public.printers
  for insert with check (public.auth_is_manager(tenant_id));
drop policy if exists printers_update on public.printers;
create policy printers_update on public.printers
  for update using (public.auth_is_manager(tenant_id)) with check (public.auth_is_manager(tenant_id));
drop policy if exists printers_delete on public.printers;
create policy printers_delete on public.printers
  for delete using (public.auth_is_manager(tenant_id));
grant select, insert, update, delete on public.printers to arena_app;

-- Station → kitchen printer (M19 #3 stations). Null = use the default printer.
alter table public.kitchen_stations
  add column if not exists printer_id uuid references public.printers(id) on delete set null;

create table if not exists public.print_jobs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  branch_id      uuid not null references public.branches(id) on delete cascade,
  printer_id     uuid not null references public.printers(id) on delete cascade,
  kind           text not null check (kind in ('kitchen_ticket','receipt','test')),
  title          text not null,
  kot_id         uuid references public.kots(id) on delete set null,
  invoice_id     uuid references public.invoices(id) on delete set null,
  payload        bytea not null,
  status         text not null default 'pending'
                 check (status in ('pending','sent','printed','failed','cancelled')),
  error          text,
  attempts       integer not null default 0,
  created_by     uuid references public.memberships(id) on delete set null,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  finished_at    timestamptz
);
create index if not exists idx_print_jobs_queue on public.print_jobs(printer_id, status, created_at);
create index if not exists idx_print_jobs_open
  on public.print_jobs(tenant_id, status) where status in ('pending','sent','failed');

alter table public.print_jobs enable row level security;
drop policy if exists print_jobs_select on public.print_jobs;
create policy print_jobs_select on public.print_jobs
  for select using (tenant_id in (select public.auth_tenant_ids()));
-- Any member can enqueue: waiters fire orders, cashiers raise bills.
drop policy if exists print_jobs_insert on public.print_jobs;
create policy print_jobs_insert on public.print_jobs
  for insert with check (tenant_id in (select public.auth_tenant_ids()));
-- Retry / cancel is a kitchen-or-manager action (mirrors kots_update).
drop policy if exists print_jobs_update on public.print_jobs;
create policy print_jobs_update on public.print_jobs
  for update using (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff','cashier'))
             with check (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff','cashier'));
grant select, insert, update on public.print_jobs to arena_app;

-- ── device-facing functions ─────────────────────────────────────────────────
create or replace function public._printer_for(p_printer uuid, p_secret text)
returns public.printers
language sql stable security definer set search_path = public
as $$
  select * from public.printers
   where id = p_printer and is_active
     and secret_hash = encode(sha256(convert_to(coalesce(p_secret,''), 'UTF8')), 'hex')
$$;

-- Poll: record liveness, say whether a job is waiting (and which).
create or replace function public.cloudprnt_poll(p_printer uuid, p_secret text, p_mac text, p_status text)
returns table(ok boolean, job_id uuid, media_type text)
language plpgsql security definer set search_path = public
as $$
declare pr public.printers;
begin
  pr := public._printer_for(p_printer, p_secret);
  if pr.id is null then
    return query select false, null::uuid, null::text;
    return;
  end if;
  update public.printers
     set last_seen_at = now(),
         device_mac = coalesce(nullif(p_mac,''), device_mac),
         last_status = nullif(left(p_status, 200), '')
   where id = pr.id;
  return query
    select true, j.id, pr.media_type
      from (select id from public.print_jobs
             where printer_id = pr.id
               and (status = 'pending' or (status = 'sent' and sent_at > now() - interval '5 minutes'))
             order by (status = 'sent') desc, created_at
             limit 1) j
    union all
    select true, null::uuid, pr.media_type
     where not exists (select 1 from public.print_jobs
                        where printer_id = pr.id
                          and (status = 'pending' or (status = 'sent' and sent_at > now() - interval '5 minutes')));
end $$;

-- Fetch: hand the job's bytes to the device and mark it sent. Re-fetching a
-- job already 'sent' is allowed (a lost response) and does not count again.
create or replace function public.cloudprnt_fetch(p_printer uuid, p_secret text, p_job uuid)
returns bytea
language plpgsql security definer set search_path = public
as $$
declare pr public.printers; j public.print_jobs;
begin
  pr := public._printer_for(p_printer, p_secret);
  if pr.id is null then return null; end if;
  select * into j from public.print_jobs
   where id = p_job and printer_id = pr.id and status in ('pending','sent') for update;
  if j.id is null then return null; end if;
  if j.status = 'pending' then
    update public.print_jobs set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = j.id;
  end if;
  return j.payload;
end $$;

-- Confirm: the device reports the outcome. Success = code "OK" or 2xx.
create or replace function public.cloudprnt_ack(p_printer uuid, p_secret text, p_job uuid, p_code text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare pr public.printers; good boolean;
begin
  pr := public._printer_for(p_printer, p_secret);
  if pr.id is null then return false; end if;
  good := upper(btrim(coalesce(p_code,''))) = 'OK' or btrim(coalesce(p_code,'')) ~ '^2';
  update public.print_jobs
     set status = case when good then 'printed' else 'failed' end,
         error = case when good then null else left(coalesce(nullif(btrim(p_code),''), 'Printer reported an error'), 200) end,
         finished_at = now()
   where id = p_job and printer_id = pr.id and status = 'sent';
  return found;
end $$;

revoke all on function public._printer_for(uuid, text) from public;
revoke all on function public.cloudprnt_poll(uuid, text, text, text) from public;
revoke all on function public.cloudprnt_fetch(uuid, text, uuid) from public;
revoke all on function public.cloudprnt_ack(uuid, text, uuid, text) from public;
grant execute on function public.cloudprnt_poll(uuid, text, text, text) to arena_app;
grant execute on function public.cloudprnt_fetch(uuid, text, uuid) to arena_app;
grant execute on function public.cloudprnt_ack(uuid, text, uuid, text) to arena_app;

-- ── fire_order_course now returns WHICH lines it fired ──────────────────────
-- (the kitchen ticket for a fired course prints exactly those lines). Return
-- type changes, so the function is dropped and recreated; the body is 0147's.
drop function if exists public.fire_order_course(uuid, smallint);
create function public.fire_order_course(p_order uuid, p_course smallint)
returns uuid[]
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant  uuid;
  v_role    public.member_role;
  v_enabled boolean;
  v_ids     uuid[];
begin
  select tenant_id into v_tenant from public.orders where id = p_order;
  if v_tenant is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  v_role := public.auth_role_in(v_tenant);
  if v_role is null or v_role not in ('owner','manager','cashier','floor_staff','kitchen_staff') then
    raise exception 'You are not allowed to fire courses.' using errcode = '42501';
  end if;
  select coalesce(courses_enabled and kds_enabled, false) into v_enabled
    from public.order_settings where tenant_id = v_tenant;
  if not coalesce(v_enabled, false) then
    raise exception 'Course firing is not turned on for this venue.' using errcode = 'P0001';
  end if;

  with up as (
    update public.order_items
       set fire_status = 'fired', fired_at = now()
     where order_id = p_order and tenant_id = v_tenant
       and course_no = p_course and fire_status = 'held' and void_status <> 'voided'
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_ids from up;

  if cardinality(v_ids) > 0 then
    update public.kots set status = 'preparing'
     where order_id = p_order and tenant_id = v_tenant and status in ('ready','served');
  end if;
  return v_ids;
end $$;
revoke all on function public.fire_order_course(uuid, smallint) from public;
grant execute on function public.fire_order_course(uuid, smallint) to arena_app;

-- ── entitlement ─────────────────────────────────────────────────────────────
insert into public.plan_entitlements (plan_id, key, value)
select p.id, 'module.printing',
       case when lower(btrim(p.name)) in ('pro','enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter','pro','enterprise','grandfathered')
on conflict (plan_id, key) do nothing;
