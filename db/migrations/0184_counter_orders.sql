-- ============================================================================
-- Arena OS — 0184 Counter food orders (M41 / ticket 1)
--
-- Food-only sale at the counter for non-restaurant venues: pick items, take
-- payment and print the bill in one step. No booking, no table, no open tab.
--
--   orders.order_type   gains 'counter'. Every other shape rule from 0157 already
--                       fits (no address / fee / driver, no handover step), so
--                       only the allowed-values check is widened.
--   module.counter_orders  its own plan entitlement. module.takeaway_delivery is
--                       restaurant-only, so reusing it would tie two unrelated
--                       products together. Granted on every existing plan: it is
--                       the same food ordering a booking already offers.
-- ============================================================================

alter table public.orders drop constraint if exists orders_order_type_check;
alter table public.orders
  add constraint orders_order_type_check check (order_type in ('dine_in', 'takeaway', 'delivery', 'counter'));

-- A counter sale is born billed (one transaction), so it never sits on the
-- takeaway board; this serves the "Counter sales" list and reports.
create index if not exists idx_orders_counter
  on public.orders (tenant_id, branch_id, created_at desc)
  where order_type = 'counter';

insert into public.plan_entitlements (plan_id, key, value)
select p.id, 'module.counter_orders', 'true'::jsonb
  from public.plans p
on conflict (plan_id, key) do nothing;

-- A retried sale / re-bill is answered from the audit row filed under its attempt key.
create index if not exists idx_audit_counter_attempt
  on public.audit_log (tenant_id, (after->>'attempt_key'))
  where action in ('counter_order.created', 'counter_order.rebilled');
