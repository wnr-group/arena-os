-- ============================================================================
-- Arena OS — 0157 Takeaway & delivery orders (M20 / AROS-182)
--
-- Additive. M14 already takes standalone orders from the public site (an order
-- with no station and no booking is a pickup). This makes the order's TYPE
-- explicit and adds what takeaway / delivery need, reusing the whole existing
-- pipeline (menu, createOrderCore, KOT, pricing, payment) — no table session
-- is ever opened for them.
--
--   orders.order_type      dine_in (default — every existing row) | takeaway | delivery
--   orders.handover_status the post-kitchen steps only: out_for_delivery /
--                          collected / delivered. The EARLIER steps (received →
--                          preparing → ready) are not stored: they are the
--                          order's kitchen ticket (kots.status), so the two can
--                          never disagree.
--   contact / pickup / address / delivery fee / driver — what each type needs.
--   orders.invoice_id      the invoice that billed it, so "paid?" is a lookup,
--                          not a guess (a standalone invoice has no booking).
--
-- Delivery fee: a snapshot on the order (so a later settings change can't
-- reprice it) that bills as its own invoice line, kind 'delivery', at its own
-- GST rate. It is a charge made by the venue, so it is part of the bill and the
-- cash taken, but it is NOT food: the food-sales / menu-mix reports (which
-- apportion payments by line kind) leave it out.
--
-- Settings default OFF (order_settings): a venue sees no change until it opts
-- in. module.takeaway_delivery entitlement: Pro/Enterprise.
-- ============================================================================

alter table public.orders
  add column if not exists order_type text not null default 'dine_in'
    check (order_type in ('dine_in', 'takeaway', 'delivery')),
  add column if not exists handover_status text
    check (handover_status is null or handover_status in ('out_for_delivery', 'collected', 'delivered')),
  add column if not exists contact_name text,
  add column if not exists contact_phone text,
  add column if not exists pickup_at timestamptz,
  add column if not exists delivery_address text,
  add column if not exists delivery_fee numeric(10,2) not null default 0 check (delivery_fee >= 0),
  add column if not exists delivery_fee_tax_rate numeric(5,2) not null default 0 check (delivery_fee_tax_rate between 0 and 100),
  add column if not exists driver_name text,
  add column if not exists driver_phone text,
  add column if not exists handed_over_at timestamptz,
  add column if not exists invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists notes text;

-- A delivery needs somewhere to go; only a delivery may carry a fee, a driver
-- or a delivered/out-for-delivery status; a dine-in order carries none of it.
do $$ begin
  alter table public.orders add constraint orders_delivery_shape_check check (
    (order_type = 'delivery' and delivery_address is not null and length(btrim(delivery_address)) > 0)
    or (order_type <> 'delivery' and delivery_address is null and delivery_fee = 0 and driver_name is null
        and (handover_status is null or handover_status = 'collected'))
  );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.orders add constraint orders_dine_in_shape_check check (
    order_type <> 'dine_in' or (handover_status is null and contact_name is null and pickup_at is null)
  );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.orders add constraint orders_handover_by_type_check check (
    handover_status is null
    or (order_type = 'takeaway' and handover_status = 'collected')
    or (order_type = 'delivery' and handover_status in ('out_for_delivery', 'delivered'))
  );
exception when duplicate_object then null; end $$;

-- Existing public pickups (no station, no booking) are takeaways — but only the
-- ones still in flight. The live-orders board lists every accepted, non-cancelled
-- takeaway whose handover_status is null, so retyping HISTORICAL pickups would
-- put every past order on it as "active", where nothing could clear it (their
-- invoice_id is unset and they are already billed). Pickups that were billed are
-- finished: they are retyped but marked collected, with the invoice that billed
-- them where exactly one can be derived from its food lines. Cancelled orders
-- stay as they were.
update public.orders o
   set order_type = 'takeaway'
 where o.booking_id is null and o.resource_id is null and o.channel = 'online'
   and o.order_type = 'dine_in' and o.status = 'open';

update public.orders o
   set order_type = 'takeaway',
       handover_status = 'collected',
       handed_over_at = coalesce(o.handed_over_at, o.updated_at),
       invoice_id = coalesce(o.invoice_id, (
         select min(ii.invoice_id::text)::uuid
           from public.invoice_items ii
           join public.order_items oi on oi.id = ii.source_id and oi.order_id = o.id
          where ii.kind = 'food' and ii.tenant_id = o.tenant_id
         having count(distinct ii.invoice_id) = 1
       ))
 where o.booking_id is null and o.resource_id is null and o.channel = 'online'
   and o.order_type = 'dine_in' and o.status = 'billed';

create index if not exists idx_orders_active_typed
  on public.orders(tenant_id, branch_id, created_at)
  where order_type <> 'dine_in' and status <> 'cancelled' and handover_status is distinct from 'delivered' and handover_status is distinct from 'collected';

-- The delivery charge is its own invoice-line kind (like service_charge).
alter table public.invoice_items
  drop constraint if exists invoice_items_kind_check;
alter table public.invoice_items
  add constraint invoice_items_kind_check
  check (kind in ('booking','food','membership','adjustment','wallet_topup','service_charge','addon','delivery'));

-- ── settings (default off) ──────────────────────────────────────────────────
alter table public.order_settings
  add column if not exists takeaway_enabled boolean not null default false,
  add column if not exists delivery_enabled boolean not null default false,
  add column if not exists default_delivery_fee numeric(10,2) not null default 0 check (default_delivery_fee >= 0),
  add column if not exists delivery_fee_tax_rate numeric(5,2) not null default 0 check (delivery_fee_tax_rate between 0 and 100);

-- ── entitlement ─────────────────────────────────────────────────────────────
insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.takeaway_delivery',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
