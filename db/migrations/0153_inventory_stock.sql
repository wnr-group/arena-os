-- ============================================================================
-- Arena OS — 0153 Inventory data model: stock items + movements (M10 / AROS-97)
--
-- Additive only. Mirrors the wallet / loyalty ledgers (0014): an APPEND-ONLY
-- movement ledger is the source of truth, and `stock_items.quantity` is the
-- on-hand figure kept equal to SUM(stock_movements.delta) by a trigger — the
-- app role cannot write it directly.
--
--   * stock_items      what is held, per tenant + branch (unit, reorder level)
--   * stock_movements  signed deltas: opening balance, purchase, adjustment,
--                      wastage and — via 0154 — the deduction for a sale
--
-- Guarantees enforced by the database, not by application discipline:
--   - a movement can only reference an item of its OWN tenant (composite FK);
--   - movements are never edited (BEFORE UPDATE trigger) and arena_app has no
--     UPDATE/DELETE grant on them;
--   - arena_app can create an item only at quantity 0 and can never UPDATE the
--     quantity column (column-level grant) — an opening balance is a movement;
--   - a sale's deduction is unique per (item, order), so it happens ONCE.
--
-- module.inventory entitlement: Pro/Enterprise.
-- ============================================================================

create table if not exists public.stock_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  branch_id     uuid not null references public.branches(id) on delete cascade,
  name          text not null check (length(btrim(name)) > 0),
  unit          text not null default 'unit' check (length(btrim(unit)) > 0),
  -- On-hand. Maintained by trg_stock_movements_apply; may go negative when
  -- stock was sold before it was counted in (a sale is never blocked).
  quantity      numeric(14,3) not null default 0,
  reorder_level numeric(14,3) not null default 0 check (reorder_level >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint stock_items_tenant_id_key unique (tenant_id, id),
  constraint stock_items_branch_name_key unique (branch_id, name)
);
create index if not exists idx_stock_items_branch on public.stock_items(tenant_id, branch_id);

create table if not exists public.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  stock_item_id uuid not null,
  delta         numeric(14,3) not null check (delta <> 0),
  reason        text,
  -- opening | purchase | adjustment | wastage | order
  source_type   text not null default 'adjustment'
                  check (source_type in ('opening', 'purchase', 'adjustment', 'wastage', 'order')),
  source_id     uuid,
  created_by    uuid references public.memberships(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint stock_movements_item_fkey
    foreign key (tenant_id, stock_item_id) references public.stock_items(tenant_id, id) on delete cascade
);
create index if not exists idx_stock_movements_item on public.stock_movements(tenant_id, stock_item_id, created_at);

-- A sale deducts an item at most once per order, however many times billing is
-- re-run (invoice void -> re-bill, webhook retry, split bill).
create unique index if not exists uq_stock_movements_order_once
  on public.stock_movements(stock_item_id, source_id)
  where source_type = 'order';

-- ── keep on-hand equal to the ledger ────────────────────────────────────────
create or replace function public.apply_stock_movement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.stock_items
     set quantity = quantity + new.delta,
         updated_at = now()
   where id = new.stock_item_id
     and tenant_id = new.tenant_id;
  return new;
end;
$$;
revoke all on function public.apply_stock_movement() from public;

drop trigger if exists trg_stock_movements_apply on public.stock_movements;
create trigger trg_stock_movements_apply
  after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

create or replace function public.stock_movements_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'stock_movements is append-only';
end;
$$;
drop trigger if exists trg_stock_movements_immutable on public.stock_movements;
create trigger trg_stock_movements_immutable
  before update on public.stock_movements
  for each row execute function public.stock_movements_immutable();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.stock_items     enable row level security;
alter table public.stock_movements enable row level security;

drop policy if exists stock_items_select on public.stock_items;
create policy stock_items_select on public.stock_items
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Owner/manager manage the catalogue. New items start empty (quantity = 0);
-- stock arrives as a movement. Each command is its own policy (AROS-183).
drop policy if exists stock_items_insert on public.stock_items;
create policy stock_items_insert on public.stock_items
  for insert with check (public.auth_is_manager(tenant_id) and quantity = 0);

drop policy if exists stock_items_update on public.stock_items;
create policy stock_items_update on public.stock_items
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Any active member's sale may deduct (billing runs as the cashier / waiter);
-- everything else — counts, purchases, wastage, corrections — is manager-only.
drop policy if exists stock_movements_insert on public.stock_movements;
create policy stock_movements_insert on public.stock_movements
  for insert with check (
    tenant_id in (select public.auth_tenant_ids())
    and (source_type = 'order' or public.auth_is_manager(tenant_id))
  );

-- No DELETE on either table, no UPDATE on the ledger, and no UPDATE of
-- quantity: items are archived (active = false), the ledger only grows.
grant select, insert on public.stock_items to arena_app;
grant update (name, unit, reorder_level, active, updated_at) on public.stock_items to arena_app;
grant select, insert on public.stock_movements to arena_app;

-- ── entitlement ─────────────────────────────────────────────────────────────
insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.inventory',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
