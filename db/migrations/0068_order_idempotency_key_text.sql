-- ============================================================================
-- Arena OS — 0068: orders.idempotency_key is text, not uuid
--
-- 0065 added this column as `uuid`, which was wrong: client code cannot rely
-- on crypto.randomUUID() to generate it — that API is SECURE-CONTEXT ONLY
-- (https:// or literally "localhost"), so it's simply undefined on this
-- project's own dev host (`{slug}.lvh.me:3000`, plain http) and throws
-- "crypto.randomUUID is not a function" the moment a customer tries to check
-- out. The codebase already solved exactly this problem once, for payments:
-- payments.idempotency_key (migration 0030) is `text`, filled by
-- lib/utils/idempotency-key.ts's newIdempotencyKey() — 128 bits from
-- crypto.getRandomValues() (no secure-context restriction), hex-encoded, NOT
-- shaped like a UUID. orders.idempotency_key should have matched that
-- pattern from the start instead of introducing a second, incompatible one.
--
-- The uniqueness guarantee is unchanged: orders_tenant_idempotency_key still
-- treats every NULL as distinct from every other NULL, so nothing that
-- predates this (or omits a key) collides with anything.
-- ============================================================================

-- current_public_order_idempotency_key() (0067) is used by both policies
-- below — drop them first so the function can be recreated with a different
-- return type (CREATE OR REPLACE cannot change a function's return type).
drop policy if exists orders_public_select on public.orders;
drop policy if exists kots_public_select on public.kots;
drop function if exists public.current_public_order_idempotency_key();

alter table public.orders
  alter column idempotency_key type text using idempotency_key::text;

create function public.current_public_order_idempotency_key()
returns text
language sql stable
as $$
  select nullif(current_setting('app.public_order_idempotency_key', true), '');
$$;
grant execute on function public.current_public_order_idempotency_key() to arena_app;

create policy orders_public_select on public.orders
  for select using (
    tenant_id = public.current_public_tenant_id()
    and (
      id = public.current_public_order_id()
      or customer_id = public.current_public_customer_id()
      or idempotency_key = public.current_public_order_idempotency_key()
    )
  );

create policy kots_public_select on public.kots
  for select using (
    tenant_id = public.current_public_tenant_id()
    and (
      order_id = public.current_public_order_id()
      or order_id in (
        select o.id from public.orders o
        where o.tenant_id = public.current_public_tenant_id()
          and o.customer_id = public.current_public_customer_id()
      )
      or order_id in (
        select o.id from public.orders o
        where o.tenant_id = public.current_public_tenant_id()
          and o.idempotency_key = public.current_public_order_idempotency_key()
      )
    )
  );
