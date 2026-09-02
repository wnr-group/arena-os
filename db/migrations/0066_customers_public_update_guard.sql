-- ============================================================================
-- Arena OS — 0066: column-scope customers_public_update at the database layer
--
-- customers_public_update (0061) scopes an UPDATE to the right TENANT, but
-- RLS is inherently row-scoped, not column-scoped — it cannot express "may
-- change notify_order_ready, nothing else". That narrower rule has only ever
-- lived in application code (lib/customers/service.ts's setNotifyOrderReady,
-- which resolves the customer server-side and sets exactly one column) —
-- safe today because that's genuinely the only public caller, but nothing at
-- the database layer stops a future public action from writing a customer's
-- name/phone/email/tags if it made a mistake resolving which row/columns to
-- touch. Flagged in the pre-merge review as a defense-in-depth gap.
--
-- A trigger, not a wider RLS policy: Postgres RLS has no column-level
-- concept, but a BEFORE UPDATE trigger comparing OLD and NEW does. Compares
-- the whole row as jsonb, minus the one column a public session may change
-- (and updated_at, which trg_customers_updated legitimately bumps on every
-- update, public or not) — so it stays correct automatically as customers
-- gains columns later, with nothing here to remember to update.
--
-- Only fires for a PUBLIC (anonymous) session: current_public_tenant_id() is
-- non-null exactly when app.public_tenant_id is set, which only
-- withPublicTenant() ever does. A staff session (withUser(), app.user_id
-- set instead) never trips this — every existing staff-side customer edit
-- (name, phone, tags, notes, membership status, ...) keeps working exactly
-- as before.
-- ============================================================================

create or replace function public.enforce_customers_public_update_columns()
returns trigger
language plpgsql
as $$
begin
  if public.current_public_tenant_id() is null then
    return new;
  end if;

  if (to_jsonb(new) - 'notify_order_ready' - 'updated_at')
     is distinct from (to_jsonb(old) - 'notify_order_ready' - 'updated_at')
  then
    raise exception 'A public session may only update notify_order_ready.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_customers_public_update_guard on public.customers;
create trigger trg_customers_public_update_guard
  before update on public.customers
  for each row execute function public.enforce_customers_public_update_columns();
