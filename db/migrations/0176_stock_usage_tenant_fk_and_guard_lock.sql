-- Follow-up to 0174/0175 review findings.
-- 1. order_item_stock_usage referenced order_items by id alone, so a row could
--    point at another tenant's order line. Make the reference tenant-composite.
-- 2. guard_order_stock_movement read the net and inserted with no lock, so two
--    concurrent restores could both pass. Serialise per (tenant, item, order).
-- 3. The guard capped restores only. It now also refuses (a) a movement for a stock
--    item that is not held at the order's own branch, and (b) a deduction larger than
--    what the order's lines can use (sum of qty x order_item_stock_usage.per_portion).
--    A legacy positive net no longer blocks a deduction: only a restore is capped by net.
--    Before applying, review any existing over-restored pairs (they are left as they are):
--      select source_id, stock_item_id, sum(delta) from stock_movements
--       where source_type = 'order' group by 1, 2 having sum(delta) > 0;

alter table public.order_item_stock_usage drop constraint if exists order_item_stock_usage_order_item_id_fkey;
alter table public.order_item_stock_usage drop constraint if exists order_item_stock_usage_order_item_tenant_fkey;
alter table public.order_item_stock_usage add constraint order_item_stock_usage_order_item_tenant_fkey
  foreign key (tenant_id, order_item_id) references public.order_items(tenant_id, id) on delete cascade not valid;
alter table public.order_item_stock_usage validate constraint order_item_stock_usage_order_item_tenant_fkey;

create or replace function public.guard_order_stock_movement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  net numeric;
  backing numeric;
begin
  if new.source_type <> 'order' then
    return new;
  end if;
  if new.source_id is null
     or not exists (select 1 from public.orders o where o.id = new.source_id and o.tenant_id = new.tenant_id) then
    raise exception 'An order stock movement must reference an order of the same tenant.' using errcode = '23514';
  end if;
  if not exists (
    select 1
      from public.orders o
      join public.stock_items si
        on si.id = new.stock_item_id and si.tenant_id = o.tenant_id and si.branch_id = o.branch_id
     where o.id = new.source_id and o.tenant_id = new.tenant_id
  ) then
    raise exception 'An order stock movement must use stock held at the order''s branch.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || new.stock_item_id::text || ':' || new.source_id::text, 0));
  select coalesce(sum(m.delta), 0) into net
    from public.stock_movements m
   where m.tenant_id = new.tenant_id
     and m.stock_item_id = new.stock_item_id
     and m.source_type = 'order'
     and m.source_id = new.source_id;
  if new.delta > 0 and net + new.delta > 0 then
    raise exception 'An order cannot give back more stock than it took.' using errcode = '23514';
  end if;
  if new.delta < 0 then
    -- What the order's lines can use, voided lines included (their snapshot stays).
    select coalesce(sum(oi.qty * u.per_portion), 0) into backing
      from public.order_items oi
      join public.order_item_stock_usage u
        on u.order_item_id = oi.id and u.tenant_id = oi.tenant_id
     where oi.tenant_id = new.tenant_id
       and oi.order_id = new.source_id
       and u.stock_item_id = new.stock_item_id;
    if -(net + new.delta) > backing then
      raise exception 'An order cannot take more stock than its lines use.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_order_stock_movement() from public;
