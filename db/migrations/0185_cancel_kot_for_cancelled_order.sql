-- Cancel the kitchen ticket of an order that has just been cancelled by a
-- front-of-house role (M41 ticket 4).
--
-- Removing the last line of an unbilled order cancels the order and its kitchen
-- ticket. The ticket UPDATE runs as the caller, and kots_update admits only
-- owner / manager / kitchen_staff — so when a CASHIER did it, the order went to
-- 'cancelled' and the UPDATE silently matched zero rows: the ticket stayed
-- 'pending'. Same class as reconcile_kot_after_line_change (0163) and
-- fire_order_course (0147): a SECURITY DEFINER function that checks the caller's
-- membership itself, so the kots policy stays exactly as strict as it was.
--
-- Deliberately narrow: it only ever sets 'cancelled', only on tickets that are
-- not already served/cancelled, and only when the ORDER is already cancelled — so
-- it cannot be used to cancel a live order's ticket.
create or replace function public.cancel_kots_for_cancelled_order(p_order uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_role   public.member_role;
  v_n      integer;
begin
  select tenant_id into v_tenant from public.orders where id = p_order and status = 'cancelled';
  if v_tenant is null then
    return 0;
  end if;

  v_role := public.auth_role_in(v_tenant);
  if v_role is null or v_role not in ('owner','manager','cashier','receptionist','floor_staff','kitchen_staff') then
    raise exception 'You are not allowed to change this ticket.' using errcode = '42501';
  end if;

  update public.kots
     set status = 'cancelled'
   where order_id = p_order and tenant_id = v_tenant and status not in ('served', 'cancelled');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.cancel_kots_for_cancelled_order(uuid) from public;
grant execute on function public.cancel_kots_for_cancelled_order(uuid) to arena_app;
