-- Let every active member of the tenant reconcile a ticket after a line change.
--
-- 0163 limited this to owner/manager/cashier/floor_staff/kitchen_staff, but the
-- app lets ANY member remove or edit an order line (removeOrderItem /
-- editOrderItemQuantity need only a session), so on a KDS tenant a receptionist
-- removing the last outstanding line got "You are not allowed to change this
-- ticket." and the whole removal rolled back. The function does one narrow thing
-- (marks a ticket ready when nothing is left to cook) after the caller's own
-- line change succeeded, so it follows that action's access rather than being
-- stricter: any active member of THIS tenant.
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
  if v_role is null then
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
