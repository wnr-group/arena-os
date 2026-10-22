-- ============================================================================
-- Arena OS — 0147 course firing (M19 / AROS-173)
--
-- Additive only. Numbered after 0146 (KDS foundation); renumber to the next
-- free number at merge time.
--
-- * order_settings: `courses_enabled` (default false) + tenant-configurable
--   `course_names`. Only effective together with the KDS (kds_enabled).
-- * order_items: course_no / course_name (SNAPSHOT at order time, like prices —
--   renaming a course later never rewrites a past order), `fire_status`
--   ('fired' default | 'held') and `fired_at`. Every existing row and every
--   order from a tenant that has not opted in is 'fired', i.e. exactly today.
-- * fire_order_course(): the one way a held course becomes active. A waiter /
--   cashier fires a course, but kots UPDATE is kitchen-only (0013) and a fire
--   may have to reopen a ready/served ticket — so rather than loosening the
--   kots policy for every front-of-house role, this SECURITY DEFINER function
--   does exactly that one thing, after checking the caller's role itself.
-- ============================================================================

alter table public.order_settings
  add column if not exists courses_enabled boolean not null default false,
  add column if not exists course_names text[] not null
    default array['Starters','Mains','Desserts']::text[];

do $$ begin
  alter table public.order_settings
    add constraint order_settings_course_names_check
    check (cardinality(course_names) between 2 and 6);
exception when duplicate_object then null; end $$;

alter table public.order_items
  add column if not exists course_no smallint not null default 1
    check (course_no between 1 and 6),
  add column if not exists course_name text,
  add column if not exists fire_status text not null default 'fired'
    check (fire_status in ('fired','held')),
  add column if not exists fired_at timestamptz;

create index if not exists idx_order_items_held
  on public.order_items(tenant_id, order_id) where fire_status = 'held';

-- Backfill parity: existing lines must all be 'fired' (the column default did
-- it) — nothing may have silently become held.
do $$
declare held bigint;
begin
  select count(*) into held from public.order_items where fire_status <> 'fired';
  if held > 0 then
    raise exception '0147 backfill parity: % order_items rows are held after migration', held;
  end if;
end $$;

create or replace function public.fire_order_course(p_order uuid, p_course smallint)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant  uuid;
  v_role    public.member_role;
  v_enabled boolean;
  v_count   integer;
begin
  select tenant_id into v_tenant from public.orders where id = p_order;
  if v_tenant is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  -- Same front-of-house set that takes orders, plus the kitchen. Receptionists
  -- and anyone who is not an active member of THIS tenant are refused.
  v_role := public.auth_role_in(v_tenant);
  if v_role is null or v_role not in ('owner','manager','cashier','floor_staff','kitchen_staff') then
    raise exception 'You are not allowed to fire courses.' using errcode = '42501';
  end if;

  select coalesce(courses_enabled and kds_enabled, false) into v_enabled
    from public.order_settings where tenant_id = v_tenant;
  if not coalesce(v_enabled, false) then
    raise exception 'Course firing is not turned on for this venue.' using errcode = 'P0001';
  end if;

  update public.order_items
     set fire_status = 'fired', fired_at = now()
   where order_id = p_order and tenant_id = v_tenant
     and course_no = p_course and fire_status = 'held' and void_status <> 'voided';
  get diagnostics v_count = row_count;

  -- Fresh food on a ticket the kitchen had finished (ready) or the floor had
  -- already served (course 1 out, now course 2) puts it back on the board.
  if v_count > 0 then
    update public.kots set status = 'preparing'
     where order_id = p_order and tenant_id = v_tenant and status in ('ready','served');
  end if;

  return v_count;
end $$;

revoke all on function public.fire_order_course(uuid, smallint) from public;
grant execute on function public.fire_order_course(uuid, smallint) to arena_app;
