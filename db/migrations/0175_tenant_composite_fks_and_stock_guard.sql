-- ============================================================================
-- Arena OS — 0175 database-level tenant hardening (review of PR #43)
--
-- 1. Tenant-composite foreign keys. A single-column FK is checked by the
--    database WITHOUT row-level security, so a member of tenant A who knows a
--    tenant B uuid could point their own row at B's printer / order line /
--    branch. (tenant_id, x_id) -> (tenant_id, id) makes a cross-tenant
--    reference impossible whatever the app does (the 0016/0124/0130 pattern).
--    Each is added NOT VALID then VALIDATEd, so existing rows are checked too.
--    ON DELETE SET NULL names only the id column: the tenant column is NOT NULL.
--
-- 2. stock_movements 'order' rows must belong to a real order of the tenant and
--    can never net positive per (stock item, order): a restore may give back
--    what the order took, never more. Before this a cashier could insert a
--    +1000 'order' movement with a random source_id.
--
-- 3. public_event_taken_counts() no longer trusts a caller-supplied tenant id.
-- ============================================================================

-- ── referenced-side keys ────────────────────────────────────────────────────
create unique index if not exists printers_tenant_id_id_key         on public.printers(tenant_id, id);
create unique index if not exists kots_tenant_id_id_key             on public.kots(tenant_id, id);
create unique index if not exists order_items_tenant_id_id_key      on public.order_items(tenant_id, id);
create unique index if not exists kitchen_stations_tenant_id_id_key on public.kitchen_stations(tenant_id, id);

-- ── print_jobs ──────────────────────────────────────────────────────────────
alter table public.print_jobs drop constraint if exists print_jobs_printer_id_fkey;
alter table public.print_jobs drop constraint if exists print_jobs_kot_id_fkey;
alter table public.print_jobs drop constraint if exists print_jobs_invoice_id_fkey;
alter table public.print_jobs drop constraint if exists print_jobs_branch_id_fkey;
alter table public.print_jobs add constraint print_jobs_printer_tenant_fkey
  foreign key (tenant_id, printer_id) references public.printers(tenant_id, id) on delete cascade not valid;
alter table public.print_jobs add constraint print_jobs_kot_tenant_fkey
  foreign key (tenant_id, kot_id) references public.kots(tenant_id, id) on delete set null (kot_id) not valid;
alter table public.print_jobs add constraint print_jobs_invoice_tenant_fkey
  foreign key (tenant_id, invoice_id) references public.invoices(tenant_id, id) on delete set null (invoice_id) not valid;
alter table public.print_jobs add constraint print_jobs_branch_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id) on delete cascade not valid;
alter table public.print_jobs validate constraint print_jobs_printer_tenant_fkey;
alter table public.print_jobs validate constraint print_jobs_kot_tenant_fkey;
alter table public.print_jobs validate constraint print_jobs_invoice_tenant_fkey;
alter table public.print_jobs validate constraint print_jobs_branch_tenant_fkey;

-- ── kot_items ───────────────────────────────────────────────────────────────
alter table public.kot_items drop constraint if exists kot_items_kot_id_fkey;
alter table public.kot_items drop constraint if exists kot_items_order_item_id_fkey;
alter table public.kot_items add constraint kot_items_kot_tenant_fkey
  foreign key (tenant_id, kot_id) references public.kots(tenant_id, id) on delete cascade not valid;
alter table public.kot_items add constraint kot_items_order_item_tenant_fkey
  foreign key (tenant_id, order_item_id) references public.order_items(tenant_id, id) on delete cascade not valid;
alter table public.kot_items validate constraint kot_items_kot_tenant_fkey;
alter table public.kot_items validate constraint kot_items_order_item_tenant_fkey;

-- ── station references ──────────────────────────────────────────────────────
alter table public.menu_items drop constraint if exists menu_items_station_id_fkey;
alter table public.order_items drop constraint if exists order_items_station_id_fkey;
alter table public.menu_categories drop constraint if exists menu_categories_station_id_fkey;
alter table public.menu_items add constraint menu_items_station_tenant_fkey
  foreign key (tenant_id, station_id) references public.kitchen_stations(tenant_id, id) on delete set null (station_id) not valid;
alter table public.order_items add constraint order_items_station_tenant_fkey
  foreign key (tenant_id, station_id) references public.kitchen_stations(tenant_id, id) on delete set null (station_id) not valid;
alter table public.menu_categories add constraint menu_categories_station_tenant_fkey
  foreign key (tenant_id, station_id) references public.kitchen_stations(tenant_id, id) on delete set null (station_id) not valid;
alter table public.menu_items validate constraint menu_items_station_tenant_fkey;
alter table public.order_items validate constraint order_items_station_tenant_fkey;
alter table public.menu_categories validate constraint menu_categories_station_tenant_fkey;

-- ── branch references ───────────────────────────────────────────────────────
alter table public.waitlist_entries drop constraint if exists waitlist_entries_branch_id_fkey;
alter table public.floor_sections drop constraint if exists floor_sections_branch_id_fkey;
alter table public.stock_items drop constraint if exists stock_items_branch_id_fkey;
alter table public.waitlist_entries add constraint waitlist_entries_branch_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id) on delete cascade not valid;
alter table public.floor_sections add constraint floor_sections_branch_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id) on delete cascade not valid;
alter table public.stock_items add constraint stock_items_branch_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id) on delete cascade not valid;
alter table public.waitlist_entries validate constraint waitlist_entries_branch_tenant_fkey;
alter table public.floor_sections validate constraint floor_sections_branch_tenant_fkey;
alter table public.stock_items validate constraint stock_items_branch_tenant_fkey;

-- ── stock_movements: order movements must be real and never net positive ────
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
  -- A restore may return what the order took, never more: the running total for
  -- this (item, order) stays at or below zero.
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

drop trigger if exists trg_stock_movements_guard_order on public.stock_movements;
create trigger trg_stock_movements_guard_order
  before insert on public.stock_movements
  for each row execute function public.guard_order_stock_movement();

-- ── public_event_taken_counts: pinned tenant only ───────────────────────────
create or replace function public.public_event_taken_counts(p_tenant_id uuid)
returns table(event_id uuid, taken integer)
language sql stable security definer set search_path = public
as $$
  select r.event_id, count(*)::int
    from public.event_registrations r
    join public.events e on e.id = r.event_id
   where e.tenant_id = p_tenant_id
     and (p_tenant_id = public.current_public_tenant_id()
          or p_tenant_id in (select public.auth_tenant_ids()))
     and e.status in ('published', 'registration_open')
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     )
   group by r.event_id;
$$;
revoke all on function public.public_event_taken_counts(uuid) from public;
grant execute on function public.public_event_taken_counts(uuid) to arena_app;
