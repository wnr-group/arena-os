-- A line left a ticket (voided / removed): if everything still on it was already
-- bumped, the ticket is done.
--
-- This used to run as SELECT ... FOR UPDATE + UPDATE on kots from the app. kots_update
-- admits only owner/manager/kitchen_staff, and Postgres demands the UPDATE policy for
-- FOR UPDATE too — so when a cashier or waiter removed the last outstanding line the
-- select returned no rows, the reconcile silently did nothing and the ticket stayed
-- 'preparing' until the kitchen pressed Bump. Same class as fire_order_course (0147):
-- a SECURITY DEFINER function that checks the caller's membership itself, so the
-- kots policy stays as strict as it was.
create or replace function public.reconcile_kot_after_line_change(p_order uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_role   public.member_role;
  v_kds    boolean;
  v_kots   uuid[];
begin
  select tenant_id into v_tenant from public.orders where id = p_order;
  if v_tenant is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  -- Anyone who can remove or void a line: an active member of THIS tenant.
  v_role := public.auth_role_in(v_tenant);
  if v_role is null or v_role not in ('owner','manager','cashier','floor_staff','kitchen_staff') then
    raise exception 'You are not allowed to change this ticket.' using errcode = '42501';
  end if;

  -- A no-op for tenants without the KDS so the legacy flow is untouched.
  select coalesce(kds_enabled, false) into v_kds from public.order_settings where tenant_id = v_tenant;
  if not coalesce(v_kds, false) then
    return false;
  end if;

  -- Lock the open tickets so two screens can't both decide "that was the last line".
  select coalesce(array_agg(id), '{}') into v_kots from (
    select id from public.kots
     where order_id = p_order and tenant_id = v_tenant and status in ('pending','preparing')
     for update
  ) k;
  if cardinality(v_kots) = 0 then
    return false;
  end if;

  -- Nothing fired and live: either nothing is left (the caller cancels the ticket)
  -- or only held lines remain, which must not read as "done".
  if not exists (
    select 1 from public.order_items
     where order_id = p_order and tenant_id = v_tenant
       and void_status <> 'voided' and fire_status = 'fired'
  ) then
    return false;
  end if;

  -- Any fired, live line with no bump row is still outstanding.
  if exists (
    select 1 from public.order_items oi
     where oi.order_id = p_order and oi.tenant_id = v_tenant
       and oi.void_status <> 'voided' and oi.fire_status = 'fired'
       and not exists (select 1 from public.kot_items ki where ki.order_item_id = oi.id)
  ) then
    return false;
  end if;

  update public.kots set status = 'ready' where id = any(v_kots) and tenant_id = v_tenant;
  return true;
end $$;

revoke all on function public.reconcile_kot_after_line_change(uuid) from public;
grant execute on function public.reconcile_kot_after_line_change(uuid) to arena_app;
