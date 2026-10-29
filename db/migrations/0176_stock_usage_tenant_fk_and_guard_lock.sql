-- Follow-up to 0174/0175 review findings.
-- 1. order_item_stock_usage referenced order_items by id alone, so a row could
--    point at another tenant's order line. Make the reference tenant-composite.
-- 2. guard_order_stock_movement read the net and inserted with no lock, so two
--    concurrent restores could both pass. Serialise per (tenant, item, order).

alter table public.order_item_stock_usage drop constraint if exists order_item_stock_usage_order_item_id_fkey;
alter table public.order_item_stock_usage drop constraint if exists order_item_stock_usage_order_item_tenant_fkey;
alter table public.order_item_stock_usage add constraint order_item_stock_usage_order_item_tenant_fkey
  foreign key (tenant_id, order_item_id) references public.order_items(tenant_id, id) on delete cascade not valid;
alter table public.order_item_stock_usage validate constraint order_item_stock_usage_order_item_tenant_fkey;

create or replace function public.guard_order_stock_movement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  net numeric;
begin
  if new.source_type <> 'order' then
    return new;
  end if;
  if new.source_id is null
     or not exists (select 1 from public.orders o where o.id = new.source_id and o.tenant_id = new.tenant_id) then
    raise exception 'An order stock movement must reference an order of the same tenant.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || new.stock_item_id::text || ':' || new.source_id::text, 0));
  select coalesce(sum(m.delta), 0) into net
    from public.stock_movements m
   where m.tenant_id = new.tenant_id
     and m.stock_item_id = new.stock_item_id
     and m.source_type = 'order'
     and m.source_id = new.source_id;
  if net + new.delta > 0 then
    raise exception 'An order cannot give back more stock than it took.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_order_stock_movement() from public;

comment on function public.reservation_by_idempotency_key(uuid, text) is
  'Returns confirmation_token to whoever presents the key. The key is a client-generated uuid acting as a bearer secret: never log it or put it in a URL.';
