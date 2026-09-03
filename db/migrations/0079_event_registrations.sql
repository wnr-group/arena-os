-- ============================================================================
-- Arena OS — 0079 event registrations, teams and the capacity guard (M15 #3).
--
-- Three tables and one idea: a place in an event is a scarce resource, and the
-- only thing that can hand one out safely is Postgres holding a lock. Every
-- rule below exists to make "confirmed registrations <= capacity" a property of
-- the DATABASE rather than a property of some code path remembering to check.
--
-- ── What "capacity" counts, decided once ────────────────────────────────────
--
--   capacity counts REGISTRATIONS (entries), never people.
--
-- For a solo event one registration is one person, so the two readings agree.
-- For a TEAM event one registration is one TEAM: a 16-team bracket is
-- capacity = 16, and how many players each team fields is `events.team_size`,
-- a separate rule enforced when a player joins a team. This is the reading the
-- business actually has — a venue with eight tables runs an eight-team
-- tournament, not an eight-PLAYER one — and it is also the only reading under
-- which `entry_fee` (charged once per registration) means "per team", which is
-- how tournament entry fees are quoted.
--
-- ── The state machine ───────────────────────────────────────────────────────
--
--   pending_payment  a place is HELD while the entrant pays. Occupies capacity.
--                    Expires (30 min from checkout, 24 h from a waitlist
--                    promotion) and is swept back to `cancelled`, releasing it.
--   registered       confirmed. Free events land here immediately; paid ones
--                    only after a signature-verified webhook.
--   waitlisted       the event was full. Occupies NOTHING and is never charged.
--   checked_in       turned up on the day. Still occupies its place.
--   cancelled        terminal. Keeps paid_amount and payment_reference so the
--                    money history survives the cancellation, exactly as
--                    bookings keep theirs.
--
-- `pending_payment` is the addition the ticket's four statuses do not name, and
-- it is the whole answer to "A starts paying, B starts paying, both succeed,
-- capacity exceeded": the place is consumed when checkout STARTS, not when the
-- webhook lands, so B is waitlisted before ever seeing a payment page. The
-- expiry is what stops an abandoned checkout from holding a place forever.
--
-- ── Why the writes go through functions instead of row policies ─────────────
--
-- 0047 gave customers a single narrow UPDATE policy on `bookings` and that was
-- the right shape there, because "may I cancel this booking?" is a question
-- about ONE row and a row policy can see one row. Capacity is not: deciding
-- whether a registration may be confirmed requires counting every OTHER
-- registration on the event, and doing it while holding a lock that stops a
-- concurrent caller counting the same way. No WITH CHECK expression can do
-- that.
--
-- So `event_registrations` has NO customer INSERT or UPDATE policy at all.
-- Customers write it only through the SECURITY DEFINER functions below, which
-- take no customer id (they read current_customer_id() themselves, so a caller
-- cannot ask about anyone but themselves) and take the event's `for update`
-- lock before they count anything. That is the same device
-- customer_booking_meta() (0047) and public_tenant_by_slug() (0022) already
-- use, applied to a write.
--
-- The one rule that IS expressible as a policy is expressed as one: that a
-- payment intent's amount must equal the event's own entry_fee lives in a WITH
-- CHECK in 0080, so a tampered amount is refused by Postgres and not merely by
-- the action that was supposed to check.
-- ============================================================================

-- ── 1. solo vs team, on the event ───────────────────────────────────────────
--
-- The M15 #1 model has `type` (what KIND of event) and `tournament_format`
-- (what shape the bracket is). Neither answers "does one person enter, or one
-- team?" — a tournament can be singles or doubles, and a class is solo but a
-- five-a-side meetup is not. So the smallest honest addition is one enum column
-- that says exactly that, plus the team's size, rather than overloading `type`
-- with a meaning it does not carry.
do $$ begin
  create type public.event_registration_mode as enum ('solo', 'team');
exception when duplicate_object then null; end $$;

alter table public.events
  add column if not exists registration_mode public.event_registration_mode not null default 'solo';

-- Players per team. NULL for a solo event; required for a team one. Written as
-- an equivalence like events_tournament_format so BOTH mistakes are caught — a
-- team event with no size, and a solo event carrying one.
alter table public.events
  add column if not exists team_size integer;

do $$ begin
  alter table public.events add constraint events_team_size check (
    (registration_mode = 'team') = (team_size is not null)
    and (team_size is null or (team_size >= 2 and team_size <= 50))
  );
exception when duplicate_object then null; end $$;

-- ── 2. enums ────────────────────────────────────────────────────────────────
do $$ begin
  create type public.event_registration_status as enum (
    'pending_payment', 'registered', 'waitlisted', 'cancelled', 'checked_in'
  );
exception when duplicate_object then null; end $$;

-- A team is withdrawn, never deleted — same reasoning as a cancelled booking:
-- the entry happened and the record of it is part of the event's history.
do $$ begin
  create type public.event_team_status as enum ('active', 'withdrawn');
exception when duplicate_object then null; end $$;

-- ── 3. event_teams ──────────────────────────────────────────────────────────
create table if not exists public.event_teams (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  event_id   uuid not null,
  name       text not null check (length(btrim(name)) > 0 and length(name) <= 80),

  -- The customer who created the team and holds its registration. Always also a
  -- row in event_team_members with is_captain — the two are written together
  -- inside claim_event_registration() and never separately.
  captain_customer_id uuid not null,

  status     public.event_team_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_teams_tenant_id_key unique (tenant_id, id),
  -- The target event_team_members FKs onto. Carrying event_id in the key is
  -- what makes "this member's team belongs to this member's event" a database
  -- fact rather than an application assumption.
  constraint event_teams_event_id_key unique (tenant_id, event_id, id),

  constraint event_teams_event_fk foreign key (tenant_id, event_id)
    references public.events(tenant_id, id) on delete cascade,
  constraint event_teams_captain_fk foreign key (tenant_id, captain_customer_id)
    references public.customers(tenant_id, id) on delete restrict
);

-- One "Thunderbolts" per event. Case- and space-insensitive, because two teams
-- a human cannot tell apart are two teams the scoreboard cannot tell apart.
-- Partial on `active` so a withdrawn team's name is released.
create unique index if not exists idx_event_teams_name
  on public.event_teams(tenant_id, event_id, lower(btrim(name)))
  where status = 'active';

create index if not exists idx_event_teams_event on public.event_teams(tenant_id, event_id);

drop trigger if exists trg_event_teams_updated on public.event_teams;
create trigger trg_event_teams_updated before update on public.event_teams
  for each row execute function public.set_updated_at();

-- ── 4. event_team_members ───────────────────────────────────────────────────
--
-- event_id is carried here as well as on the team. It is not denormalisation
-- for speed: it is what lets the composite FK below reference
-- (tenant_id, event_id, id) on event_teams — so a member row can never name a
-- team from a different event — AND what lets the "one team per event per
-- customer" unique index exist at all.
create table if not exists public.event_team_members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null,
  team_id     uuid not null,
  customer_id uuid not null,
  is_captain  boolean not null default false,
  created_at  timestamptz not null default now(),

  constraint event_team_members_team_fk foreign key (tenant_id, event_id, team_id)
    references public.event_teams(tenant_id, event_id, id) on delete cascade,
  constraint event_team_members_customer_fk foreign key (tenant_id, customer_id)
    references public.customers(tenant_id, id) on delete cascade
);

-- The same person cannot be in a team twice…
create unique index if not exists idx_event_team_members_unique
  on public.event_team_members(team_id, customer_id);

-- …and cannot play for two teams in the same event. This is the constraint that
-- makes "duplicate registration" impossible on the team side, the way
-- idx_event_registrations_active does it on the entry side.
create unique index if not exists idx_event_team_members_one_per_event
  on public.event_team_members(tenant_id, event_id, customer_id);

-- Exactly one captain per team.
create unique index if not exists idx_event_team_members_captain
  on public.event_team_members(team_id)
  where is_captain;

create index if not exists idx_event_team_members_customer
  on public.event_team_members(tenant_id, customer_id);

-- ── 5. event_registrations ──────────────────────────────────────────────────
create table if not exists public.event_registrations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null,

  -- The M9 customer. There is no second identity: a registrant is always a row
  -- in `customers`, reached through the OTP session
  -- (lib/auth/customer-session.ts) and never through a name typed into a form.
  customer_id uuid not null,

  -- NULL for a solo entry; the team this entry IS, for a team event.
  team_id     uuid,

  status      public.event_registration_status not null,

  -- Rupees, numeric(10,2) like every other money column, read as a string in
  -- TypeScript so no amount touches a float. Zero for a free event and for a
  -- paid one that has not been paid yet — it records money RECEIVED, not money
  -- owed. The fee owed is always events.entry_fee, read fresh.
  paid_amount numeric(10, 2) not null default '0' check (paid_amount >= 0),

  -- Razorpay's `pay_…`, written ONLY by the verified-webhook path
  -- (confirm_event_registration_payment below). Never by a browser, never by a
  -- free registration — see event_registrations_paid.
  payment_reference text,

  -- The capacity HOLD. Set only while status = 'pending_payment'; a hold in the
  -- past occupies nothing and is swept to `cancelled` by
  -- expire_event_registration_holds().
  payment_hold_expires_at timestamptz,

  -- Money arrived but the place could not be honoured (the classic "payment
  -- landed after the last place went"). Mirrors bookings.deposit_review_required
  -- from 0047 exactly, and for the same reason: this codebase never auto-refunds.
  refund_required boolean not null default false,

  registered_at  timestamptz,
  waitlisted_at  timestamptz,
  cancelled_at   timestamptz,
  checked_in_at  timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_registrations_tenant_id_key unique (tenant_id, id),

  constraint event_registrations_event_fk foreign key (tenant_id, event_id)
    references public.events(tenant_id, id) on delete cascade,
  constraint event_registrations_customer_fk foreign key (tenant_id, customer_id)
    references public.customers(tenant_id, id) on delete cascade,
  -- Three columns, so the registration, its team and its event are provably the
  -- same event. A registration cannot point at a team entered in something else.
  constraint event_registrations_team_fk foreign key (tenant_id, event_id, team_id)
    references public.event_teams(tenant_id, event_id, id) on delete cascade,

  -- A hold exists exactly while payment is pending. Stated as an equivalence so
  -- neither a pending row without a deadline nor a confirmed row still carrying
  -- one can be written.
  constraint event_registrations_hold check (
    (status = 'pending_payment') = (payment_hold_expires_at is not null)
  ),

  -- No money without a verified reference for it. This is what makes "do not
  -- create fake payment references for free registrations" a constraint rather
  -- than a code-review note — and it also refuses a paid_amount written by
  -- anything that did not come through the webhook.
  constraint event_registrations_paid check (
    paid_amount = 0 or payment_reference is not null
  )
);

-- THE duplicate-registration rule: at most one LIVE entry per customer per
-- event. Partial on status so a cancelled entry does not block re-registering,
-- exactly like idx_payment_intents_one_pending_booking (0058).
create unique index if not exists idx_event_registrations_active
  on public.event_registrations(tenant_id, event_id, customer_id)
  where status in ('pending_payment', 'registered', 'waitlisted', 'checked_in');

-- The occupancy count, which runs under the event lock on every claim.
create index if not exists idx_event_registrations_event_status
  on public.event_registrations(event_id, status);

-- FIFO promotion reads exactly this.
create index if not exists idx_event_registrations_waitlist
  on public.event_registrations(event_id, created_at, id)
  where status = 'waitlisted';

-- The customer's own list, newest first.
create index if not exists idx_event_registrations_customer
  on public.event_registrations(tenant_id, customer_id, created_at desc);

-- The staff work queue: entries holding money that could not be honoured.
create index if not exists idx_event_registrations_refund_required
  on public.event_registrations(tenant_id)
  where refund_required;

drop trigger if exists trg_event_registrations_updated on public.event_registrations;
create trigger trg_event_registrations_updated before update on public.event_registrations
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 6. THE CAPACITY CORE
--
-- Everything below assumes its caller holds `select … from events … for update`
-- on the event. That lock is the serialisation point: two customers pressing
-- Register at the same instant queue behind it, so they cannot both read the
-- same occupancy and both decide there is room. Nothing here is safe without
-- it, and every entry point takes it first.
-- ============================================================================

-- How many places are currently consumed.
--
-- Waitlisted entries count for NOTHING — that is what makes a waitlist a
-- waitlist. A pending_payment hold counts while it is live, which is what stops
-- two simultaneous paid checkouts from overselling the last place.
create or replace function public.event_registration_occupancy(p_event_id uuid)
returns integer
language sql stable
as $$
  select count(*)::int
    from public.event_registrations r
   where r.event_id = p_event_id
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     );
$$;

-- Release abandoned checkouts.
--
-- Called under the lock at the top of every claim and cancellation, so the
-- system heals itself on traffic rather than needing a scheduled job — the same
-- reason getPublicEvents() prunes by ends_at instead of waiting for a manager
-- to mark events completed. These rows never paid: paid_amount stays 0 and
-- payment_reference stays null, so the money history is untouched.
create or replace function public.expire_event_registration_holds(p_event_id uuid)
returns integer
language sql
as $$
  with swept as (
    update public.event_registrations
       set status = 'cancelled',
           cancelled_at = now(),
           payment_hold_expires_at = null
     where event_id = p_event_id
       and status = 'pending_payment'
       and payment_hold_expires_at <= now()
    returning id
  )
  select count(*)::int from swept;
$$;

-- Move waitlisted entries up, oldest first, while there is room.
--
-- FIFO is (created_at, id): a registration row is created once and never
-- recreated, so its creation instant IS the moment that customer joined the
-- queue. `id` breaks ties so the order is total and stable rather than
-- arbitrary when two rows share a timestamp.
--
-- A PAID event does not promote anyone straight to `registered` — being
-- promoted is an invitation to pay, not a free place. The promoted row becomes
-- `pending_payment` with a 24-hour hold (longer than a checkout's 30 minutes,
-- because the customer is not sitting at the page waiting), and only a verified
-- webhook can turn it into `registered`. The hold means the place is genuinely
-- reserved for them meanwhile, and expires back to the queue if they never pay.
--
-- The loop cannot oversell: each pass re-reads occupancy, and every promotion
-- increases it by one (a live hold occupies), so it stops exactly at capacity.
create or replace function public.promote_event_waitlist(p_event_id uuid)
returns integer
language plpgsql
as $$
declare
  v_capacity integer;
  v_fee      numeric(10,2);
  v_promoted integer := 0;
  v_next     uuid;
begin
  select capacity, entry_fee into v_capacity, v_fee
    from public.events where id = p_event_id;
  if not found then return 0; end if;

  loop
    if v_capacity is not null
       and public.event_registration_occupancy(p_event_id) >= v_capacity then
      exit;
    end if;

    select id into v_next
      from public.event_registrations
     where event_id = p_event_id and status = 'waitlisted'
     order by created_at asc, id asc
     limit 1;

    exit when v_next is null;

    if v_fee > 0 then
      update public.event_registrations
         set status = 'pending_payment',
             payment_hold_expires_at = now() + interval '24 hours'
       where id = v_next;
    else
      update public.event_registrations
         set status = 'registered',
             registered_at = now(),
             payment_hold_expires_at = null
       where id = v_next;
    end if;

    v_promoted := v_promoted + 1;
  end loop;

  return v_promoted;
end;
$$;

-- Internal. A customer must not be able to sweep or promote an arbitrary event
-- on demand; these run only from the entry points below, which authorise first.
-- (CREATE FUNCTION grants EXECUTE to PUBLIC by default — hence the revokes,
-- the same device 0043/0050 use for refresh_daily_revenue().)
revoke all on function public.event_registration_occupancy(uuid)     from public;
revoke all on function public.expire_event_registration_holds(uuid)  from public;
revoke all on function public.promote_event_waitlist(uuid)           from public;

-- ============================================================================
-- 7. THE ENTRY POINTS
--
-- SECURITY DEFINER, so they can lock `events` and count every registration on
-- it — neither of which a customer connection can do, and both of which the
-- capacity rule requires. What makes that safe is that they take NO identity
-- parameter: the customer is read from current_customer_id(), which comes from
-- the validated OTP session that withCustomer() pinned, so there is no argument
-- through which a caller could act as anybody else.
--
-- They return a refusal CODE rather than raising, for the same reason
-- checkCancelEligibility() does: the caller turns codes into sentences, and a
-- refusal is an expected answer rather than an exception.
-- ============================================================================

create or replace function public.claim_event_registration(
  p_event_id  uuid,
  p_team_name text default null
)
returns table (
  refusal             text,
  registration_id     uuid,
  registration_status public.event_registration_status,
  team_id             uuid,
  entry_fee           numeric
)
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_tenant   uuid;
  v_event    public.events%rowtype;
  v_status   public.event_registration_status;
  v_team     uuid;
begin
  refusal := null; registration_id := null; registration_status := null;
  team_id := null; entry_fee := null;

  if v_customer is null then
    refusal := 'not_signed_in'; return next; return;
  end if;
  v_tenant := public.current_customer_tenant_id();
  if v_tenant is null then
    refusal := 'not_signed_in'; return next; return;
  end if;

  -- THE lock. Everything after this line is serialised per event.
  --
  -- The tenant predicate is what makes another venue's event id useless: the
  -- tenant comes from the customer's own row (current_customer_tenant_id()
  -- looks it up inside the database), never from the caller.
  select * into v_event from public.events e
   where e.id = p_event_id and e.tenant_id = v_tenant
   for update;
  if not found then
    refusal := 'not_found'; return next; return;
  end if;

  entry_fee := v_event.entry_fee;

  -- Registration is a lifecycle question and only one status answers yes.
  if v_event.status <> 'registration_open' then
    refusal := 'not_open'; return next; return;
  end if;
  if v_event.ends_at <= now() then
    refusal := 'ended'; return next; return;
  end if;

  -- Bring the event up to date while we hold the lock: release dead holds, then
  -- let the queue take whatever that freed. Doing it here means the occupancy
  -- read below is the truth and not a stale count.
  perform public.expire_event_registration_holds(p_event_id);
  perform public.promote_event_waitlist(p_event_id);

  if exists (
    select 1 from public.event_registrations r
     where r.event_id = p_event_id
       and r.customer_id = v_customer
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
  ) then
    refusal := 'already_registered'; return next; return;
  end if;

  -- Playing for someone else's team already counts as being in this event.
  if exists (
    select 1 from public.event_team_members m
     where m.event_id = p_event_id and m.customer_id = v_customer
  ) then
    refusal := 'already_in_team'; return next; return;
  end if;

  -- Solo vs team is the EVENT's rule, read from the row we just locked — never
  -- inferred from whether the browser happened to send a team name.
  if v_event.registration_mode = 'team' then
    if p_team_name is null or btrim(p_team_name) = '' then
      refusal := 'team_name_required'; return next; return;
    end if;
  elsif p_team_name is not null then
    refusal := 'not_a_team_event'; return next; return;
  end if;

  -- The decision, with the count taken under the lock.
  if v_event.capacity is not null
     and public.event_registration_occupancy(p_event_id) >= v_event.capacity then
    v_status := 'waitlisted';
  elsif v_event.entry_fee > 0 then
    v_status := 'pending_payment';
  else
    v_status := 'registered';
  end if;

  if v_event.registration_mode = 'team' then
    begin
      insert into public.event_teams (tenant_id, event_id, name, captain_customer_id)
      values (v_tenant, p_event_id, btrim(p_team_name), v_customer)
      returning id into v_team;
    exception when unique_violation then
      refusal := 'team_name_taken'; return next; return;
    end;

    insert into public.event_team_members (tenant_id, event_id, team_id, customer_id, is_captain)
    values (v_tenant, p_event_id, v_team, v_customer, true);
  end if;

  insert into public.event_registrations (
    tenant_id, event_id, customer_id, team_id, status,
    payment_hold_expires_at, registered_at, waitlisted_at
  ) values (
    v_tenant, p_event_id, v_customer, v_team, v_status,
    case when v_status = 'pending_payment' then now() + interval '30 minutes' end,
    case when v_status = 'registered'      then now() end,
    case when v_status = 'waitlisted'      then now() end
  )
  returning id into registration_id;

  registration_status := v_status;
  team_id := v_team;
  return next;
end;
$$;

-- Join a team somebody else created.
--
-- Joining consumes NO capacity — the team's own registration already did that —
-- so this function does not touch the occupancy count. What it does enforce is
-- the team's size, the event's lifecycle, and that a player is in at most one
-- team per event. It still takes the event lock so it cannot race a
-- cancellation that withdraws the team underneath it.
--
-- A player joins THEMSELVES. There is no parameter for whose membership this
-- is, which is how "a customer cannot register another customer on their
-- behalf" is guaranteed rather than merely intended.
create or replace function public.join_event_team(p_team_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_tenant   uuid;
  v_team     public.event_teams%rowtype;
  v_event    public.events%rowtype;
  v_members  integer;
begin
  if v_customer is null then return 'not_signed_in'; end if;
  v_tenant := public.current_customer_tenant_id();
  if v_tenant is null then return 'not_signed_in'; end if;

  select * into v_team from public.event_teams t
   where t.id = p_team_id and t.tenant_id = v_tenant;
  if not found then return 'not_found'; end if;

  select * into v_event from public.events e
   where e.id = v_team.event_id and e.tenant_id = v_tenant
   for update;
  if not found then return 'not_found'; end if;

  if v_event.registration_mode <> 'team' then return 'not_a_team_event'; end if;
  if v_event.status <> 'registration_open' then return 'not_open'; end if;
  if v_event.ends_at <= now() then return 'ended'; end if;
  if v_team.status <> 'active' then return 'team_withdrawn'; end if;

  -- The team's entry must still be live. A team whose registration was
  -- cancelled is not something anyone should be able to join into.
  if not exists (
    select 1 from public.event_registrations r
     where r.team_id = p_team_id
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
  ) then
    return 'team_withdrawn';
  end if;

  if exists (
    select 1 from public.event_registrations r
     where r.event_id = v_event.id and r.customer_id = v_customer
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
  ) then
    return 'already_registered';
  end if;

  if exists (
    select 1 from public.event_team_members m
     where m.event_id = v_event.id and m.customer_id = v_customer
  ) then
    return 'already_in_team';
  end if;

  select count(*) into v_members from public.event_team_members m where m.team_id = p_team_id;
  if v_members >= v_event.team_size then return 'team_full'; end if;

  insert into public.event_team_members (tenant_id, event_id, team_id, customer_id, is_captain)
  values (v_tenant, v_event.id, p_team_id, v_customer, false);

  return 'joined';
end;
$$;

-- Cancel a registration, free its place, and let the queue take it.
--
-- One function for both actors. A customer may cancel their OWN entry; an
-- owner/manager may cancel any entry in their tenant, and additionally one that
-- has already checked in (staff override the door, customers do not). The
-- authorisation is read from whichever session context is set — there is no
-- "actor" argument to spoof, and a caller with neither context authorises as
-- nobody.
--
-- Cancelling is idempotent in effect: a second call finds a non-cancellable
-- status and refuses, so no side effect (promotion, audit entry) can fire twice
-- for one cancellation.
create or replace function public.cancel_event_registration(p_registration_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_reg      public.event_registrations%rowtype;
  v_is_staff boolean := false;
  v_is_owner boolean := false;
  v_was_held boolean;
  v_event_id uuid;
  v_lock     uuid;
begin
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;
  if not found then return 'not_found'; end if;

  v_is_owner := v_customer is not null and v_reg.customer_id = v_customer;
  v_is_staff := public.auth_is_manager(v_reg.tenant_id);

  -- Identical answer for "no such registration" and "not yours", so walking
  -- UUIDs tells an attacker nothing.
  if not (v_is_owner or v_is_staff) then return 'not_found'; end if;

  -- The lock, before any state is read for a decision.
  v_event_id := v_reg.event_id;
  select e.id into v_lock from public.events e where e.id = v_event_id for update;

  -- Re-read under the lock: a concurrent cancellation or a webhook may have
  -- moved it between the ownership check and here.
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;

  if v_reg.status = 'cancelled' then return 'already_cancelled'; end if;
  if v_reg.status = 'checked_in' and not v_is_staff then return 'checked_in'; end if;

  -- Did this entry hold a place? Decides whether anyone can be promoted.
  v_was_held := v_reg.status in ('registered', 'checked_in')
             or (v_reg.status = 'pending_payment' and v_reg.payment_hold_expires_at > now());

  update public.event_registrations
     set status = 'cancelled',
         cancelled_at = now(),
         payment_hold_expires_at = null,
         -- Money already taken cannot be handed back automatically — this
         -- codebase never auto-refunds (see 0047). It raises a flag a human
         -- works through, and leaves paid_amount / payment_reference exactly
         -- where they are so the history survives.
         refund_required = (v_reg.paid_amount > 0)
   where id = p_registration_id;

  -- A team's entry IS the team. Withdrawing it releases the name and stops
  -- anyone joining what is no longer entered.
  if v_reg.team_id is not null then
    update public.event_teams set status = 'withdrawn' where id = v_reg.team_id;
  end if;

  perform public.expire_event_registration_holds(v_event_id);
  if v_was_held then
    perform public.promote_event_waitlist(v_event_id);
  end if;

  -- audit_log (0018), reused rather than a second trail — the same choice the
  -- customer booking cancellation made. actor_membership_id stays null because
  -- the actor may be a customer; who it was is recorded in the payload.
  insert into public.audit_log
    (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
  values (
    v_reg.tenant_id,
    null,
    case when v_is_owner then 'event_registration.cancelled_by_customer'
                         else 'event_registration.cancelled_by_staff' end,
    'event_registration',
    p_registration_id,
    jsonb_build_object('status', v_reg.status, 'paidAmount', v_reg.paid_amount),
    jsonb_build_object(
      'status', 'cancelled',
      'customerId', v_reg.customer_id,
      'refundRequired', v_reg.paid_amount > 0
    )
  );

  return 'cancelled';
end;
$$;

-- ============================================================================
-- 8. CONFIRMING A VERIFIED PAYMENT
--
-- Deliberately NOT security definer: its only caller is the Razorpay webhook,
-- which already runs on the owner connection (lib/payments/webhook.ts documents
-- why), and it must be unreachable from arena_app — a function that turns a
-- registration into a paid one is exactly what a customer connection must not
-- be able to call. It is granted to nobody, and the revoke below removes the
-- default PUBLIC execute.
--
-- The caller has ALREADY verified the HMAC signature, matched the payment to
-- our own payment_intent, and checked the amount against that intent. This
-- function is the last gate and re-derives the fee from the EVENT anyway, so a
-- payment for the wrong money cannot confirm a place even if everything above
-- it were wrong.
-- ============================================================================
create or replace function public.confirm_event_registration_payment(
  p_registration_id   uuid,
  p_payment_reference text,
  p_amount            numeric
)
returns text
language plpgsql
as $$
declare
  v_reg   public.event_registrations%rowtype;
  v_event public.events%rowtype;
  v_occ   integer;
begin
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;
  if not found then return 'not_found'; end if;

  select * into v_event from public.events e where e.id = v_reg.event_id for update;
  if not found then return 'not_found'; end if;

  -- Re-read under the lock.
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;

  -- Idempotency, independent of the webhook's own: the same Razorpay payment
  -- arriving twice finds its own reference already stored and changes nothing.
  if v_reg.payment_reference is not null then
    if v_reg.payment_reference = p_payment_reference then return 'duplicate'; end if;
    -- A DIFFERENT payment against an already-settled registration. Never apply
    -- a second one — that is charging the entry fee twice.
    return 'already_paid';
  end if;

  -- The money must equal the event's OWN fee. The browser never supplied this
  -- number and neither did the gateway: it is read from the event row here, in
  -- the same transaction that is about to confirm the place.
  --
  -- A mismatch means the fee moved between checkout and capture. The place is
  -- NOT granted for money that does not match the advertised price, and the
  -- money is not kept quietly either: the entry is cancelled and flagged, which
  -- is the same landing the "place is gone" case below uses.
  if p_amount <> v_event.entry_fee then
    update public.event_registrations
       set status = 'cancelled',
           cancelled_at = now(),
           payment_hold_expires_at = null,
           paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_amount_mismatch',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status, 'expected', v_event.entry_fee),
            jsonb_build_object('status', 'cancelled', 'refundRequired', true,
                               'paidAmount', p_amount, 'paymentReference', p_payment_reference));
    return 'amount_mismatch';
  end if;

  -- Already holds a place (a free-then-repriced event, or a manual staff
  -- confirmation that beat the webhook). Record the money against the entry it
  -- paid for and change nothing else — cancelling a confirmed entrant because
  -- their payment arrived would be absurd.
  if v_reg.status in ('registered', 'checked_in') then
    update public.event_registrations
       set paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = false
     where id = p_registration_id;
    return 'confirmed';
  end if;

  -- Is there a place for them? Counted EXCLUDING this registration, so the
  -- answer is the same whether their own hold is still live (it is, and the
  -- count is one short of capacity) or expired while they were paying (it is
  -- not, and they take a place only if one is genuinely free).
  select count(*)::int into v_occ
    from public.event_registrations r
   where r.event_id = v_reg.event_id
     and r.id <> p_registration_id
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     );

  if v_event.capacity is not null and v_occ >= v_event.capacity then
    -- Paid, but the place is gone. Capacity is the invariant that does not
    -- bend, so the entry is cancelled and flagged for a refund — the customer
    -- is never left silently charged with nothing to show for it.
    update public.event_registrations
       set status = 'cancelled',
           cancelled_at = now(),
           payment_hold_expires_at = null,
           paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_unfulfillable',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status),
            jsonb_build_object('status', 'cancelled', 'refundRequired', true,
                               'paidAmount', p_amount, 'paymentReference', p_payment_reference));
    return 'unfulfillable';
  end if;

  update public.event_registrations
     set status = 'registered',
         registered_at = now(),
         payment_hold_expires_at = null,
         paid_amount = p_amount,
         payment_reference = p_payment_reference,
         refund_required = false
   where id = p_registration_id;

  return 'confirmed';
end;
$$;

revoke all on function public.confirm_event_registration_payment(uuid, text, numeric) from public;

-- ============================================================================
-- 9. NARROW READERS
-- ============================================================================

-- Places taken, for the PUBLIC listing and detail pages.
--
-- SECURITY DEFINER because a stranger has no policy on event_registrations and
-- must not get one — "how many places are left" is public, "who registered" is
-- not. This returns only an aggregate, and only for events already publicly
-- visible under events_public_select (0077), so it cannot be used to learn
-- anything about a draft or a private event.
create or replace function public.public_event_taken_counts(p_tenant_id uuid)
returns table (event_id uuid, taken integer)
language sql stable security definer set search_path = public
as $$
  select r.event_id, count(*)::int
    from public.event_registrations r
    join public.events e on e.id = r.event_id
   where e.tenant_id = p_tenant_id
     and e.status in ('published', 'registration_open')
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     )
   group by r.event_id;
$$;

-- The teams a customer may join, for a team event.
--
-- Names and headcounts only — no customer ids, no phone numbers, no payment
-- anything. The tenant is derived from whichever context is set (a signed-in
-- customer's own tenant, or the subdomain pin), never taken as an argument.
create or replace function public.public_event_teams(p_event_id uuid)
returns table (team_id uuid, team_name text, member_count integer, team_size integer)
language sql stable security definer set search_path = public
as $$
  select t.id,
         t.name,
         (select count(*)::int from public.event_team_members m where m.team_id = t.id),
         e.team_size
    from public.event_teams t
    join public.events e on e.id = t.event_id
   where t.event_id = p_event_id
     and t.status = 'active'
     and e.tenant_id = coalesce(public.current_customer_tenant_id(), public.current_public_tenant_id())
     and e.status in ('published', 'registration_open')
     and exists (
       select 1 from public.event_registrations r
        where r.team_id = t.id
          and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
     )
   order by t.created_at asc;
$$;

-- "Where do I stand in this event?" — the one reader the registration page and
-- the CTA need, for entrants AND for team players who have no registration row
-- of their own (their captain holds it).
--
-- Takes no customer id: it answers about current_customer_id() and nobody else.
-- Returns narrow facts. payment_reference is deliberately NOT among them — a
-- gateway reference has no business in a page payload, and a team-mate must
-- certainly never see their captain's. Money columns are nulled for anyone but
-- the entrant who paid.
create or replace function public.my_event_participation(p_event_id uuid)
returns table (
  registration_id     uuid,
  registration_status public.event_registration_status,
  is_captain          boolean,
  is_own_registration boolean,
  team_id             uuid,
  team_name           text,
  team_member_count   integer,
  waitlist_position   integer,
  paid_amount         numeric,
  refund_required     boolean,
  hold_expires_at     timestamptz
)
language sql stable security definer set search_path = public
as $$
  with me as (
    select public.current_customer_id() as cid, public.current_customer_tenant_id() as tid
  ),
  -- The entry that concerns this customer: their own, or their team's.
  mine as (
    select r.*,
           (r.customer_id = (select cid from me))                       as own,
           coalesce(m.is_captain, r.customer_id = (select cid from me)) as captain
      from public.event_registrations r
      left join public.event_team_members m
             on m.team_id = r.team_id and m.customer_id = (select cid from me)
     where r.event_id = p_event_id
       and r.tenant_id = (select tid from me)
       and (select cid from me) is not null
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
       and (r.customer_id = (select cid from me) or m.id is not null)
     limit 1
  )
  select
    mine.id,
    mine.status,
    mine.captain,
    mine.own,
    mine.team_id,
    t.name,
    (select count(*)::int from public.event_team_members m2 where m2.team_id = mine.team_id),
    case when mine.status = 'waitlisted' then (
      select count(*)::int
        from public.event_registrations w
       where w.event_id = mine.event_id
         and w.status = 'waitlisted'
         and (w.created_at, w.id) <= (mine.created_at, mine.id)
    ) end,
    case when mine.own then mine.paid_amount     else null end,
    case when mine.own then mine.refund_required else null end,
    case when mine.own then mine.payment_hold_expires_at else null end
  from mine
  left join public.event_teams t on t.id = mine.team_id;
$$;

-- ============================================================================
-- 10. RLS + GRANTS
-- ============================================================================

alter table public.event_registrations enable row level security;
alter table public.event_teams         enable row level security;
alter table public.event_team_members  enable row level security;

-- ── staff ───────────────────────────────────────────────────────────────────
-- The same read-wide / write-narrow split `events` itself uses (0076): every
-- active member of the tenant can see who is entered (the front desk needs the
-- door list), and only an owner/manager may write.
drop policy if exists event_registrations_select on public.event_registrations;
create policy event_registrations_select on public.event_registrations
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists event_registrations_manager_write on public.event_registrations;
create policy event_registrations_manager_write on public.event_registrations
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists event_teams_select on public.event_teams;
create policy event_teams_select on public.event_teams
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists event_teams_manager_write on public.event_teams;
create policy event_teams_manager_write on public.event_teams
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists event_team_members_select on public.event_team_members;
create policy event_team_members_select on public.event_team_members
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists event_team_members_manager_write on public.event_team_members;
create policy event_team_members_manager_write on public.event_team_members
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- ── the customer ────────────────────────────────────────────────────────────
--
-- READ ONLY, and only their own entry. There is deliberately no customer INSERT
-- or UPDATE policy: every customer write goes through the functions above,
-- which hold the event lock. If someone later adds one, the restrictive policy
-- below still confines it to the caller's own rows.
--
-- A team-mate is NOT given a select policy on their captain's registration —
-- that row carries paid_amount and payment_reference. They read what they need
-- through my_event_participation(), which returns neither.
drop policy if exists event_registrations_customer_select on public.event_registrations;
create policy event_registrations_customer_select on public.event_registrations
  for select using (
    customer_id = public.current_customer_id()
    and tenant_id = public.current_customer_tenant_id()
  );

-- Restrictive, so it ANDs with everything rather than ORing. Same device 0045
-- uses on bookings and wallet_transactions, and for the same reason: a future
-- permissive policy (or a stray public_tenant_id pin) must not be able to widen
-- a customer's view of this table.
drop policy if exists event_registrations_customer_isolation on public.event_registrations;
create policy event_registrations_customer_isolation on public.event_registrations
  as restrictive for all
  using (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  )
  with check (
    public.current_customer_id() is null
    or customer_id = public.current_customer_id()
  );

-- Teams the customer plays in — the roster view. No money lives on these two
-- tables, so a team-mate may see them.
drop policy if exists event_teams_customer_select on public.event_teams;
create policy event_teams_customer_select on public.event_teams
  for select using (
    tenant_id = public.current_customer_tenant_id()
    and exists (
      select 1 from public.event_team_members m
       where m.team_id = event_teams.id and m.customer_id = public.current_customer_id()
    )
  );

drop policy if exists event_teams_customer_isolation on public.event_teams;
create policy event_teams_customer_isolation on public.event_teams
  as restrictive for all
  using (
    public.current_customer_id() is null
    or exists (
      select 1 from public.event_team_members m
       where m.team_id = event_teams.id and m.customer_id = public.current_customer_id()
    )
  )
  with check (
    public.current_customer_id() is null
    or exists (
      select 1 from public.event_team_members m
       where m.team_id = event_teams.id and m.customer_id = public.current_customer_id()
    )
  );

drop policy if exists event_team_members_customer_select on public.event_team_members;
create policy event_team_members_customer_select on public.event_team_members
  for select using (
    tenant_id = public.current_customer_tenant_id()
    and exists (
      select 1 from public.event_team_members mine
       where mine.team_id = event_team_members.team_id
         and mine.customer_id = public.current_customer_id()
    )
  );

drop policy if exists event_team_members_customer_isolation on public.event_team_members;
create policy event_team_members_customer_isolation on public.event_team_members
  as restrictive for all
  using (
    public.current_customer_id() is null
    or exists (
      select 1 from public.event_team_members mine
       where mine.team_id = event_team_members.team_id
         and mine.customer_id = public.current_customer_id()
    )
  )
  with check (
    public.current_customer_id() is null
    or exists (
      select 1 from public.event_team_members mine
       where mine.team_id = event_team_members.team_id
         and mine.customer_id = public.current_customer_id()
    )
  );

-- A signed-in customer must be able to read the event they are entering — for
-- the page itself, and (in 0080) for the WITH CHECK that ties a payment
-- intent's amount to events.entry_fee. Everything except `draft` is admitted: a
-- draft is the venue's private working copy, and every other status has already
-- been announced. There is still no customer WRITE policy on events of any kind.
drop policy if exists events_customer_select on public.events;
create policy events_customer_select on public.events
  for select using (
    tenant_id = public.current_customer_tenant_id()
    and status <> 'draft'
  );

-- ── no public policy, anywhere ──────────────────────────────────────────────
-- A stranger reads places-left through public_event_taken_counts() and team
-- names through public_event_teams(), both aggregates. They get no ROW of these
-- three tables, so there is no path by which an entrant list, a phone number or
-- a payment reference reaches an unauthenticated request.

-- ── grants ──────────────────────────────────────────────────────────────────
-- No DELETE. A registration is cancelled, never removed — the same rule
-- payment_intents follows, and what the audit trail depends on.
grant select, insert, update on public.event_registrations to arena_app;
grant select, insert, update on public.event_teams          to arena_app;
grant select, insert, update on public.event_team_members   to arena_app;

grant execute on function public.claim_event_registration(uuid, text) to arena_app;
grant execute on function public.join_event_team(uuid)                to arena_app;
grant execute on function public.cancel_event_registration(uuid)      to arena_app;
grant execute on function public.public_event_taken_counts(uuid)      to arena_app;
grant execute on function public.public_event_teams(uuid)             to arena_app;
grant execute on function public.my_event_participation(uuid)         to arena_app;
