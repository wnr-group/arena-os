-- ============================================================================
-- Arena OS — 0045 customer portal RLS (AROS-88): the database half of the
-- customer portal's auth guard.
--
-- A THIRD identity now exists on the arena_app connection:
--
--   app.user_id           staff        → auth_tenant_ids()            (0002)
--   app.public_tenant_id  anonymous    → current_public_tenant_id()   (0022)
--   app.customer_id       a customer   → current_customer_id()        (here)
--
-- withCustomer() (db/index.ts) sets the third and only the third, so under a
-- customer context the staff and public policies both evaluate against NULL and
-- match nothing. What is added below is what a logged-in customer may see.
--
-- ── Why each table gets TWO policies ────────────────────────────────────────
--
-- Postgres policies are PERMISSIVE unless declared otherwise, and permissive
-- policies are OR-ed. The pre-existing public policies on `customers` and
-- `bookings` read `tenant_id = current_public_tenant_id()` and deliberately
-- expose the whole tenant (the public booking flow needs that; its safety comes
-- from column discipline in application code, as 0022/0023 document at length).
--
-- A single permissive `customer_id = current_customer_id()` policy would
-- therefore be one stray `set_config('app.public_tenant_id', …)` away from
-- being useless: OR-ed with the public policy, the customer would see every row
-- in the tenant.
--
-- So each table also gets a RESTRICTIVE policy — restrictive policies are
-- AND-ed with the permissive result, and cannot be widened by anything. It
-- reads "if there is no customer context, do not interfere; if there IS one,
-- the row must belong to that customer, whatever any other policy says".
--
-- Effective visibility becomes:
--
--   (staff-tenant OR public-tenant OR own-customer)   ← permissive, OR-ed
--   AND (no customer context OR row is that customer's) ← restrictive, AND-ed
--
-- Staff and anonymous callers are completely unaffected: with app.customer_id
-- unset, current_customer_id() is NULL and the restrictive clause is trivially
-- true. Nothing existing is dropped, altered or weakened.
-- ============================================================================

-- ── identity helpers ────────────────────────────────────────────────────────
-- Mirrors current_app_user_id() (0002) exactly, including missing_ok => true so
-- an unset GUC yields NULL rather than raising: "no customer context" must be a
-- value that quietly matches nothing, not an error that takes the query down.
create or replace function public.current_customer_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.customer_id', true), '')::uuid;
$$;

-- The tenant that customer belongs to, derived INSIDE the database.
--
-- The point is that the portal never tells us which tenant it is — the caller
-- supplies only a customer id, and the tenant is looked up from it. A stolen or
-- guessed customer id from another tenant therefore cannot be paired with a
-- tenant of the attacker's choosing.
--
-- SECURITY DEFINER for the same reason auth_tenant_ids() is: it must read
-- `customers` without tripping the RLS being defined on `customers` below, and
-- it cannot leak because it only ever returns the tenant of the caller's own
-- customer id.
create or replace function public.current_customer_tenant_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select tenant_id from public.customers
   where id = public.current_customer_id();
$$;

grant execute on function public.current_customer_id()        to arena_app;
grant execute on function public.current_customer_tenant_id() to arena_app;

-- ── customers: the customer's own row ───────────────────────────────────────
-- Keyed on the primary key, not on tenant: `customers.id` is globally unique,
-- so this is exactly one row and knowing another customer's UUID buys nothing
-- — the comparison is against the session's id, which the browser never
-- supplies.
drop policy if exists customers_customer_select on public.customers;
create policy customers_customer_select on public.customers
  for select using (id = public.current_customer_id());

drop policy if exists customers_customer_isolation on public.customers;
create policy customers_customer_isolation on public.customers
  as restrictive for all
  using (
    public.current_customer_id() is null
    or id = public.current_customer_id()
  )
  with check (
    public.current_customer_id() is null
    or id = public.current_customer_id()
  );

-- ── bookings ────────────────────────────────────────────────────────────────
-- The tenant predicate is belt-and-braces: bookings already carry a composite
-- FK to (customers.tenant_id, customers.id) from 0016, so a booking in another
-- tenant cannot name this customer. Stating it anyway means the policy stays
-- correct on its own terms rather than by reference to a constraint elsewhere.
drop policy if exists bookings_customer_select on public.bookings;
create policy bookings_customer_select on public.bookings
  for select using (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
  );

drop policy if exists bookings_customer_isolation on public.bookings;
create policy bookings_customer_isolation on public.bookings
  as restrictive for all
  using (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  )
  with check (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  );

-- ── wallet_transactions ─────────────────────────────────────────────────────
-- Unlike bookings these carry a plain FK to customers(id) rather than the
-- composite one, so the tenant predicate here is load-bearing, not decoration.
drop policy if exists wallet_transactions_customer_select on public.wallet_transactions;
create policy wallet_transactions_customer_select on public.wallet_transactions
  for select using (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
  );

drop policy if exists wallet_transactions_customer_isolation on public.wallet_transactions;
create policy wallet_transactions_customer_isolation on public.wallet_transactions
  as restrictive for all
  using (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  )
  with check (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  );

-- ── loyalty_transactions ────────────────────────────────────────────────────
drop policy if exists loyalty_transactions_customer_select on public.loyalty_transactions;
create policy loyalty_transactions_customer_select on public.loyalty_transactions
  for select using (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
  );

drop policy if exists loyalty_transactions_customer_isolation on public.loyalty_transactions;
create policy loyalty_transactions_customer_isolation on public.loyalty_transactions
  as restrictive for all
  using (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  )
  with check (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  );

-- ── customer_memberships ────────────────────────────────────────────────────
drop policy if exists customer_memberships_customer_select on public.customer_memberships;
create policy customer_memberships_customer_select on public.customer_memberships
  for select using (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
  );

drop policy if exists customer_memberships_customer_isolation on public.customer_memberships;
create policy customer_memberships_customer_isolation on public.customer_memberships
  as restrictive for all
  using (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  )
  with check (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  );

-- ── grants ──────────────────────────────────────────────────────────────────
-- Nothing new. arena_app already holds these privileges from the migrations
-- that created each table, and the portal is READ-ONLY: every policy added
-- above is `for select`, so a customer context can see its own rows and write
-- nothing at all. The restrictive policies additionally cap any INSERT/UPDATE
-- that some other permissive policy might otherwise have allowed while a
-- customer context is set.
--
-- Customer session rows are NOT reachable from this connection by design —
-- customer_sessions is revoked from arena_app in 0044 and is touched only
-- through the owner connection, exactly like the staff `sessions` table.
