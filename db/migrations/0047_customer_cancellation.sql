-- ============================================================================
-- Arena OS — 0047 customer self-service cancellation (AROS-90)
--
-- Until now the customer portal has been strictly READ-ONLY: every policy added
-- in 0045/0046 is `for select`, and the restrictive policies cap anything else.
-- This is the first customer-initiated WRITE, so the new privileges below are
-- deliberately the narrowest that can express "a customer may cancel their own
-- upcoming booking, and nothing else".
-- ============================================================================

-- ── 1. the cancellation policy, per tenant ──────────────────────────────────
-- No such setting existed. Shaped exactly like loyalty_settings (0039) and
-- payment_settings (0032): tenant_id IS the primary key, one row per tenant, no
-- surrogate id. That is the established home for per-tenant module config, and
-- nothing existing was suitable — business_profiles is the owner-only LEGAL
-- identity for GST invoices, not a place for an operational rule.
create table if not exists public.booking_cancellation_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  -- Self-service cancellation is ON by default: letting customers manage their
  -- own bookings is the entire point of the portal epic, and a venue that wants
  -- phone-only cancellation can turn it off.
  customer_cancellation_enabled boolean not null default true,

  -- How close to the start time a customer may still cancel themselves.
  --
  -- DEFAULT 24 HOURS. The ticket does not name a number; 24h is the ordinary
  -- convention for venue bookings and is long enough that a released slot can
  -- realistically be resold. A tenant can set 0 for "cancel any time before it
  -- starts". The cap keeps a typo from making every booking permanently
  -- uncancellable.
  cutoff_hours integer not null default 24 check (cutoff_hours >= 0 and cutoff_hours <= 720),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_booking_cancellation_settings_updated
  on public.booking_cancellation_settings;
create trigger trg_booking_cancellation_settings_updated
  before update on public.booking_cancellation_settings
  for each row execute function public.set_updated_at();

alter table public.booking_cancellation_settings enable row level security;

-- Read by staff, written only by owner/manager — the same split tax_rates and
-- loyalty_settings use for a rule that changes what customers may do.
drop policy if exists booking_cancellation_settings_select
  on public.booking_cancellation_settings;
create policy booking_cancellation_settings_select on public.booking_cancellation_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists booking_cancellation_settings_write
  on public.booking_cancellation_settings;
create policy booking_cancellation_settings_write on public.booking_cancellation_settings
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- The customer must be able to READ the rule that is about to be applied to
-- them — a cancellation policy is posted terms, not a secret. Read-only, and
-- only their own tenant's row.
drop policy if exists booking_cancellation_settings_customer_select
  on public.booking_cancellation_settings;
create policy booking_cancellation_settings_customer_select
  on public.booking_cancellation_settings
  for select using (tenant_id = public.current_customer_tenant_id());

grant select, insert, update on public.booking_cancellation_settings to arena_app;

-- ── 2. the deposit review flag ──────────────────────────────────────────────
-- The ticket is explicit: never auto-refund. But a cancelled booking that the
-- venue is holding money against cannot simply go quiet either, so cancelling
-- one raises this flag and the money is left exactly where it is.
--
-- A boolean on `bookings` rather than a new table: the fact belongs to the
-- booking, there is at most one such fact per booking, and staff need to filter
-- on it. No refund row, no payment row and no invoice is touched by the
-- customer path — the flag plus the audit entry (below) is the whole record.
alter table public.bookings
  add column if not exists deposit_review_required boolean not null default false;

-- The staff work queue: "cancelled bookings still holding money".
create index if not exists idx_bookings_deposit_review
  on public.bookings(tenant_id)
  where deposit_review_required;

-- ── 3. the customer's ONE permitted write on bookings ───────────────────────
-- USING is evaluated against the OLD row and WITH CHECK against the NEW one, so
-- this policy encodes the entire permitted state transition in the database:
--
--     own booking, currently 'confirmed'   →   own booking, now 'cancelled'
--
-- A customer therefore cannot mark a booking completed, cannot un-cancel one,
-- cannot cancel somebody else's, and cannot cancel one they are already checked
-- in to. Even if the application layer were bypassed entirely, that is the only
-- UPDATE this role can perform under a customer context.
--
-- 'checked_in' is deliberately excluded: the customer is physically at the
-- venue by then, and walking out is a conversation with the front desk, not a
-- self-service action.
--
-- KNOWN LIMIT, stated rather than hidden: RLS is row-level, not column-level,
-- so this permits an UPDATE that also alters other columns as long as the row
-- still ends up cancelled and still belongs to the caller. A column grant
-- cannot narrow it because staff writes travel through the same database role.
-- The application layer is what restricts the write to status/cancelled_at/
-- deposit_review_required (see lib/portal/cancel.ts), and nothing a customer
-- can reach issues arbitrary SQL.
drop policy if exists bookings_customer_cancel on public.bookings;
create policy bookings_customer_cancel on public.bookings
  for update
  using (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
    and status = 'confirmed'
  )
  with check (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
    and status = 'cancelled'
  );

-- ── 4. letting the existing trigger free the slot ───────────────────────────
-- trg_bookings_sync_slots (0003) is what actually releases the time: it flips
-- booking_slots.active to false when a booking becomes cancelled, in the SAME
-- transaction as the status change. That trigger function is plain plpgsql, not
-- SECURITY DEFINER, so it runs as arena_app and is itself subject to RLS.
--
-- Without this policy the trigger's UPDATE would silently match zero rows and a
-- cancelled booking would keep occupying an active slot — no error, just a
-- permanently blocked resource. The narrow shape mirrors §3: the slot must
-- belong to a booking of the calling customer.
drop policy if exists booking_slots_customer_release on public.booking_slots;
create policy booking_slots_customer_release on public.booking_slots
  for update
  using (
    exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  )
  with check (
    exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  );

-- ── 5. the audit trail ──────────────────────────────────────────────────────
-- audit_log (0018) already exists and is append-only by construction — select +
-- insert policies only, select + insert grants only — so the customer path
-- reuses it rather than inventing a second trail.
--
-- `actor_membership_id` is a staff membership and is NULL for a customer; who
-- the customer was is recorded inside the `after` payload instead. The policy
-- pins BOTH the action string and the null actor, so the only row a customer
-- context can ever append is this one kind of entry — it cannot forge a staff
-- action, cannot write against another entity type, and cannot backdate one.
--
-- There is deliberately NO customer SELECT policy: a customer writes to the
-- trail and can never read it.
drop policy if exists audit_log_customer_insert on public.audit_log;
create policy audit_log_customer_insert on public.audit_log
  for insert with check (
    tenant_id = public.current_customer_tenant_id()
    and actor_membership_id is null
    and entity_type = 'booking'
    and action = 'booking.cancelled_by_customer'
  );

-- ── 6. the facts the portal needs but must not be able to read ──────────────
-- Deciding whether a cancellation is safe needs two things a customer has no
-- business reading: whether the kitchen has an open order against the booking,
-- and whether the venue is holding money for it. Rebooking needs a third: which
-- resource TYPE to send them back to, which lives on `resources` — a table with
-- no customer policy at all.
--
-- SECURITY DEFINER, the same device 0022 uses for public_tenant_by_slug(): it
-- reads past RLS internally but is safe because (a) the booking id is checked
-- against current_customer_id() INSIDE the function, so another customer's
-- booking returns no rows, and (b) it returns three narrow facts — two booleans
-- and a public resource-type id — never an amount, an order line, a payment id
-- or a gateway reference.
--
-- Taking no customer id as a parameter is the point: the caller cannot ask
-- about anyone but themselves.
create or replace function public.customer_booking_meta(p_booking_id uuid)
returns table (
  has_open_orders boolean,
  has_deposit boolean,
  rebook_resource_type_id uuid
)
language sql stable security definer set search_path = public
as $$
  select
    exists (
      select 1 from public.orders o
       where o.booking_id = b.id and o.status = 'open'
    ) as has_open_orders,
    -- Either a recorded deposit on the booking, or a gateway intent that
    -- actually settled (0033/0035). Both mean money is being held.
    (
      b.deposit > 0
      or exists (
        select 1 from public.payment_intents pi
         where pi.booking_id = b.id and pi.status = 'paid'
      )
    ) as has_deposit,
    (
      select r.resource_type_id
        from public.booking_slots s
        join public.resources r on r.id = s.resource_id
       where s.booking_id = b.id
       order by s.starts_at asc
       limit 1
    ) as rebook_resource_type_id
  from public.bookings b
  where b.id = p_booking_id
    and b.customer_id = public.current_customer_id();
$$;

grant execute on function public.customer_booking_meta(uuid) to arena_app;

-- ── grants ──────────────────────────────────────────────────────────────────
-- Nothing new on bookings, booking_slots or audit_log: arena_app has held those
-- privileges since the migrations that created each table, and the policies
-- above are what decide whether a customer context may use them.
