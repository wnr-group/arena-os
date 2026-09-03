-- ============================================================================
-- Arena OS — 0078 events: the event model behind M15 tournaments & events.
--
-- One table, deliberately. A tournament, a coaching class, a meetup, a watch
-- party and a birthday party differ in what they MEAN, not in what a venue
-- stores about them: all five have a title, a window, a room, a capacity and a
-- price. `type` carries the meaning; only the tournament-specific bracket
-- format is a separate nullable column, constrained below so it can exist for
-- exactly one type and no other.
--
-- ── Why branch_id is NOT an RLS boundary ────────────────────────────────────
--
-- No policy in this codebase scopes on branch_id (checked across 0001-0069),
-- and this one does not start. TENANT is the isolation boundary; a branch is a
-- data attribute a member of the tenant may read and a manager may set. What
-- branch_id DOES need is the guarantee that it can never point at some other
-- tenant's branch, and that is a foreign key's job, not a policy's — see the
-- composite FK below.
--
-- ── Money and time follow the house conventions ─────────────────────────────
--
-- entry_fee is numeric(10,2) like every other money column (bookings.total,
-- happy_hours.discount_value), read in TypeScript as a string so no amount ever
-- touches a float. starts_at/ends_at are timestamptz like bookings, not local
-- date+time: an event has one true instant, and the venue's timezone is presentation.
-- ============================================================================

-- ── tenant-safe branch references ───────────────────────────────────────────
--
-- The composite-FK pattern this codebase already uses for customers (0016) and
-- bookings/invoices (0018): a plain `references branches(id)` would happily let
-- tenant A's event point at tenant B's branch, because the FK never sees
-- tenant_id. Referencing (tenant_id, id) makes that combination unrepresentable
-- in the database rather than merely unlikely in the application.
--
-- branches has no (tenant_id, id) unique key yet — nothing had needed a
-- tenant-safe reference to it before — so add one. Guarded like 0018 does, so
-- re-running this file is a no-op.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.branches'::regclass
       and conname  = 'branches_tenant_id_key'
  ) then
    alter table public.branches add constraint branches_tenant_id_key unique (tenant_id, id);
  end if;
end $$;

-- ── enums ───────────────────────────────────────────────────────────────────
do $$ begin
  create type public.event_type as enum ('tournament', 'class', 'meetup', 'watch_party', 'party');
exception when duplicate_object then null; end $$;

-- Bracket shape. Only meaningful for `type = 'tournament'`; the CHECK below
-- makes that a database rule rather than a convention.
do $$ begin
  create type public.tournament_format as enum ('single_elim', 'double_elim', 'round_robin', 'points');
exception when duplicate_object then null; end $$;

-- The lifecycle. Ordered as it is lived:
--
--   draft              being written, invisible to customers
--   published          announced, registration not yet open
--   registration_open  accepting entrants
--   full               capacity reached (reversible — an entrant may withdraw)
--   in_progress        running
--   completed          finished
--   cancelled          called off; terminal from anywhere active
--
-- The legal MOVES between these are enforced in lib/events/service.ts
-- (EVENT_TRANSITIONS), not here: a CHECK constraint can see the new row but not
-- the old one, so it cannot express "completed may not go back to draft".
-- The transition rule needs both, so it lives in the transactional core that
-- reads the current row FOR UPDATE, exactly as KOT status does (0013).
do $$ begin
  create type public.event_status as enum (
    'draft', 'published', 'registration_open', 'full', 'in_progress', 'completed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

-- ── the table ───────────────────────────────────────────────────────────────
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- on delete restrict, like bookings(0003): an event is a commitment to
  -- customers, so deleting the room out from under it must fail loudly rather
  -- than cascade the event away or silently null the venue.
  branch_id   uuid not null,

  title       text not null check (length(btrim(title)) > 0),
  type        public.event_type not null,
  description text,

  -- Public URL from lib/storage/s3.ts uploadImage(). Nullable: an event is
  -- announceable before its artwork exists.
  banner_url  text,

  starts_at   timestamptz not null,
  ends_at     timestamptz not null,

  -- NULL means unlimited. Zero would mean "an event nobody may attend", which
  -- is not a thing a venue wants to express, so the floor is 1.
  capacity    integer check (capacity is null or capacity >= 1),

  -- Free events are the common case, hence the default. Negative would be the
  -- venue paying the attendee, which is a refund, not an entry fee.
  entry_fee   numeric(10, 2) not null default '0' check (entry_fee >= 0),

  tournament_format public.tournament_format,

  status      public.event_status not null default 'draft',

  created_by  uuid references public.memberships(id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- The window must be a window. Equal timestamps are rejected too: a
  -- zero-length event cannot be attended.
  constraint events_window check (ends_at > starts_at),

  -- The bracket format belongs to tournaments and only to tournaments. Written
  -- as an equivalence so BOTH mistakes are caught: a tournament with no format,
  -- and a birthday party carrying a double-elimination bracket.
  constraint events_tournament_format check (
    (type = 'tournament') = (tournament_format is not null)
  ),

  -- Referenced by later M15 stories (registrations, brackets) that need a
  -- tenant-safe FK back to an event, the same way invoices reference bookings.
  constraint events_tenant_id_key unique (tenant_id, id),

  -- See the header: this is what makes a cross-tenant branch_id impossible.
  constraint events_branch_fk foreign key (tenant_id, branch_id)
    references public.branches(tenant_id, id) on delete restrict
);

-- The list page reads one tenant's events newest-window-first; the public
-- listing (a later story) will filter the same way with a status predicate.
create index if not exists idx_events_tenant_starts on public.events(tenant_id, starts_at desc);
create index if not exists idx_events_branch on public.events(branch_id);

drop trigger if exists trg_events_updated on public.events;
create trigger trg_events_updated before update on public.events
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.events enable row level security;

-- Readable by any active member of the tenant. Staff need to see what is on:
-- a cashier taking a walk-in, a floor member setting up the room. The same
-- read-wide/write-narrow split loyalty_tiers (0078's sibling, 0049) and
-- tax_rates (0009) use.
drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Created and edited by owner/manager only. This is the database half of
-- requireManager() in lib/actions/events.ts: even if an action forgot its
-- guard, a cashier's connection cannot write this table.
drop policy if exists events_manager_write on public.events;
create policy events_manager_write on public.events
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Standard business-table grant; the policies above decide who may actually
-- do which of these.
grant select, insert, update, delete on public.events to arena_app;
