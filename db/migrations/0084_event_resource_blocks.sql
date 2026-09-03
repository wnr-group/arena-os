-- ============================================================================
-- Arena OS — 0084 event resource blocking (M15 #4)
--
-- An event reserves gaming stations for its window, so nothing else can be
-- booked on them while it runs.
--
-- ══ THE CENTRAL DECISION: NO SECOND AVAILABILITY SYSTEM ═════════════════════
--
-- An event block IS a `booking_slots` row. It is not a parallel table that
-- availability queries have to remember to consult, because that is precisely
-- the design that rots: one reader gets updated, another does not, and a
-- station is offered twice.
--
-- 0003 already put the whole guarantee in one place:
--
--     constraint booking_slots_no_overlap
--       exclude using gist (resource_id with =, tstzrange(starts_at, ends_at) with &&)
--       where (active)
--
-- Writing event blocks into that table buys, for free and with no application
-- code able to forget it:
--
--   * event ↔ booking exclusion, enforced by Postgres inside whatever
--     transaction attempts the write. createBookingCore() already inserts its
--     slots and lets this constraint reject overlap — so both the public
--     booking path and the staff walk-in path reject an event-blocked resource
--     WITHOUT A SINGLE LINE CHANGING in either;
--   * event ↔ event exclusion, by exactly the same rule;
--   * `[starts_at, ends_at)` boundary semantics, because `tstzrange`'s default
--     bound is inclusive-exclusive. A booking that ends exactly when an event
--     starts does NOT overlap it, and neither does one that starts exactly when
--     the event ends. That is the rule the ticket asks for, and it is inherited
--     rather than re-implemented;
--   * every availability reader, already. lib/booking/public-availability.ts
--     and lib/actions/availability.ts both read `booking_slots` filtered on
--     `active` and `resource_id` WITHOUT joining `bookings`, so an event row
--     lands in their results unchanged;
--   * release, via `active`. Cancelling an event flips its rows to false and
--     the time is bookable again, the same mechanism a cancelled booking uses.
--
-- ══ WHAT THIS MIGRATION ADDS ════════════════════════════════════════════════
--
--   1. `booking_slots.event_id`     — whose block a row is. NULL for a booking.
--   2. `booking_slots.booking_id`   — relaxed to NULL for an event block.
--      + a CHECK that exactly ONE of the two is set, so a row is always
--      attributable and never both.
--   3. `events.resource_scope`      — none | branch | specific.
--   4. `event_resources`            — WHICH stations a 'specific' event claims.
--      The selection is not the block: a draft event has a selection and no
--      rows in booking_slots at all (see the lifecycle note below).
--   5. a trigger closing the branch-wide bypass (see §3 below).
--
-- ══ SELECTION vs BLOCK, and why they are two things ═════════════════════════
--
-- `event_resources` records what a manager CHOSE. `booking_slots` records what
-- is currently RESERVED. They are deliberately separate because a draft event
-- has the first and must not have the second — a manager planning next month's
-- tournament must not silently make ten stations unbookable today.
--
-- Keeping the choice in its own table also makes an edit diffable: adding a
-- station, removing one, or moving the event's window are all "recompute the
-- blocks from the selection", not "guess what the old blocks meant".
-- ============================================================================

-- ── tenant-safe resource references ─────────────────────────────────────────
--
-- The composite-FK pattern 0016/0018/0078 use. A plain `references
-- resources(id)` would let tenant A's event claim tenant B's station, because
-- the FK never sees tenant_id. Referencing (tenant_id, id) makes that
-- combination unrepresentable rather than merely rejected by application code
-- that could be bypassed.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.resources'::regclass
       and conname  = 'resources_tenant_id_key'
  ) then
    alter table public.resources add constraint resources_tenant_id_key unique (tenant_id, id);
  end if;
end $$;

-- ── 1/2. booking_slots carries event blocks ─────────────────────────────────

alter table public.booking_slots
  add column if not exists event_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.booking_slots'::regclass
       and conname  = 'booking_slots_event_fk'
  ) then
    alter table public.booking_slots
      add constraint booking_slots_event_fk
      foreign key (tenant_id, event_id)
      references public.events(tenant_id, id) on delete cascade;
  end if;
end $$;

-- A booking's slots die with the booking; an event's blocks die with the event.
-- `on delete cascade` on both sides means neither can leave an orphan holding
-- time against a resource.
alter table public.booking_slots alter column booking_id drop not null;

-- Exactly one owner. Not "at least one" — a row belonging to both a booking and
-- an event would be released by two different lifecycles and re-activated by
-- whichever ran last.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.booking_slots'::regclass
       and conname  = 'booking_slots_one_owner'
  ) then
    alter table public.booking_slots
      add constraint booking_slots_one_owner
      check (num_nonnulls(booking_id, event_id) = 1);
  end if;
end $$;

-- The release/reapply path's only lookup: "this event's blocks".
create index if not exists idx_booking_slots_event
  on public.booking_slots(event_id) where (event_id is not null);

-- ── 3. events.resource_scope ────────────────────────────────────────────────
--
--   none      the event reserves nothing. A talk in the cafe area, or an event
--             whose stations have not been decided yet. The DEFAULT, so every
--             event that existed before this migration keeps behaving exactly
--             as it did.
--   branch    every bookable resource in the event's branch.
--   specific  the stations listed in event_resources.
do $$ begin
  create type public.event_resource_scope as enum ('none', 'branch', 'specific');
exception when duplicate_object then null; end $$;

alter table public.events
  add column if not exists resource_scope public.event_resource_scope not null default 'none';

-- ── 4. event_resources — the SELECTION ──────────────────────────────────────
create table if not exists public.event_resources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null,
  resource_id uuid not null,
  created_at  timestamptz not null default now(),
  -- One row per station per event. Selecting the same station twice is a
  -- request that means the same thing as selecting it once.
  unique (event_id, resource_id),
  -- Both composite, so a selection cannot cross tenants in either direction.
  constraint event_resources_event_fk
    foreign key (tenant_id, event_id)
    references public.events(tenant_id, id) on delete cascade,
  constraint event_resources_resource_fk
    foreign key (tenant_id, resource_id)
    references public.resources(tenant_id, id) on delete cascade
);
create index if not exists idx_event_resources_event on public.event_resources(event_id);
create index if not exists idx_event_resources_resource on public.event_resources(tenant_id, resource_id);

-- ── 5. THE BRANCH-WIDE BYPASS, closed in the database ───────────────────────
--
-- A 'branch' event is materialised as one booking_slots row per bookable
-- resource in the branch, because the exclusion constraint keys on resource_id
-- and cannot express "everything in this branch". That materialisation is a
-- snapshot, which leaves one hole the ticket names explicitly: a station
-- CREATED (or moved into the branch, or brought back from maintenance) while a
-- branch-wide event is live would carry no block, and would be bookable
-- straight through the event.
--
-- Closing that in application code alone would mean every future path that
-- inserts a resource has to remember. So it is closed here, where nothing can
-- route around it: any resource that becomes bookable in a branch inherits the
-- blocks of every event already blocking that branch.
--
-- The insert is `on conflict do nothing` against the same exclusion constraint
-- the rest of this design leans on — if the new station somehow already holds
-- overlapping time, the event block is simply not added rather than the
-- resource insert failing. That direction is deliberate: a live event must not
-- make it impossible to add a station, and the exclusion constraint still
-- prevents the double-book either way.
create or replace function public.apply_branch_event_blocks()
returns trigger language plpgsql as $$
begin
  -- Only a bookable resource can hold a block. A station in maintenance or
  -- inactive is already unbookable by every availability reader.
  if new.status <> 'available' then
    return new;
  end if;

  insert into public.booking_slots (
    tenant_id, booking_id, event_id, resource_id,
    starts_at, ends_at, rate_applied, slot_total,
    resource_name, resource_type_name, active
  )
  select
    e.tenant_id, null, e.id, new.id,
    e.starts_at, e.ends_at, 0, 0,
    new.name, coalesce(rt.name, 'Resource'), true
  from public.events e
  left join public.resource_types rt on rt.id = new.resource_type_id
  where e.tenant_id = new.tenant_id
    and e.branch_id = new.branch_id
    and e.resource_scope = 'branch'
    -- The same statuses lib/events/resource-blocks.ts treats as blocking.
    -- Stated in both places on purpose: this trigger is the last line of
    -- defence and must not depend on the application agreeing with it.
    and e.status in ('published', 'registration_open', 'full', 'in_progress')
    and e.ends_at > now()
  on conflict do nothing;

  return new;
end;
$$;

-- Fires when a resource is created, when it moves branch, and when it becomes
-- bookable again after maintenance — the three ways a station can appear inside
-- a live branch-wide block.
drop trigger if exists trg_resources_branch_event_blocks on public.resources;
create trigger trg_resources_branch_event_blocks
  after insert or update of branch_id, status on public.resources
  for each row execute function public.apply_branch_event_blocks();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.event_resources enable row level security;

-- Any member may read which stations an event claims; only a manager may
-- change it. The same split events itself uses (0078).
drop policy if exists event_resources_select on public.event_resources;
create policy event_resources_select on public.event_resources
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists event_resources_write on public.event_resources;
create policy event_resources_write on public.event_resources
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.event_resources to arena_app;

-- ── the customer-portal restrictive policy has to tolerate an event block ───
--
-- 0046 added a RESTRICTIVE policy to booking_slots that, under a customer
-- session, admits a row only when it hangs off a booking belonging to that
-- customer:
--
--     current_customer_id() is null
--     or exists (select 1 from bookings b where b.id = booking_slots.booking_id …)
--
-- An event block has `booking_id is null`, so that EXISTS is false and the
-- restrictive policy would hide it from any read taken under a customer
-- session. Availability is never read that way today — the portal's "book
-- again" hands off to the public flow, which runs under withPublicTenant() —
-- so this is not currently a live bypass. It is repaired anyway, because the
-- failure mode if a customer-context availability read is ever added would be
-- silent: the customer would be offered a station the event owns, and would
-- only discover it when the exclusion constraint refused the booking.
--
-- Event blocks carry no customer data — a resource id and a time window — so
-- admitting them under a customer session leaks nothing. The permissive
-- policies still decide whether the row is visible at all; this only stops the
-- restrictive one from vetoing it.
drop policy if exists booking_slots_customer_isolation on public.booking_slots;
create policy booking_slots_customer_isolation on public.booking_slots
  as restrictive for all
  using (
    public.current_customer_id() is null
    or booking_slots.event_id is not null
    or exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  )
  with check (
    public.current_customer_id() is null
    or booking_slots.event_id is not null
    or exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  );

comment on column public.booking_slots.event_id is
  'Set when this row is an EVENT RESOURCE BLOCK (M15 #4) rather than a customer reservation; booking_id is then null. The booking_slots_no_overlap exclusion constraint treats both identically, which is what makes an event and a booking mutually exclusive on one resource without any application-level availability check.';

comment on column public.events.resource_scope is
  'none = reserves nothing; branch = every bookable resource in the event branch; specific = the stations listed in event_resources. Blocks are materialised into booking_slots only while the event status is published/registration_open/full/in_progress.';
