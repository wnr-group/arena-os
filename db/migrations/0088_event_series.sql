-- ============================================================================
-- Arena OS — 0088 recurring event series (M15 #8)
--
-- A TEMPLATE table (event_series) plus two provenance columns on `events`.
--
-- ══ A GENERATED OCCURRENCE IS AN ORDINARY EVENT ═════════════════════════════
--
-- Same `events` table, same RLS, same lifecycle, same registration, capacity,
-- check-in, resource blocking, bracket and public pages. It merely records
-- which series produced it and for which period. Nothing downstream needs to
-- know it was automated, and nothing downstream had to change.
--
-- This is the shape 0042 established for recurring expenses, deliberately
-- reused rather than reinvented: a generated expense is an ordinary expense.
--
-- ══ THE IDEMPOTENCY GUARANTEE ══════════════════════════════════════════════
--
-- `unique (series_id, occurrence_period)`. That INDEX — not an application
-- "does one already exist?" check — is what makes a second run, or two
-- concurrent runs, unable to create next Tuesday's class twice. A SELECT-then-
-- INSERT has a window two jobs can both pass through; a unique index has none.
--
-- Both columns are NULLABLE and NULLs are DISTINCT to a unique index, so
-- hand-created events (both null) never collide with each other or with a
-- series. The paired CHECK stops a half-populated row claiming provenance it
-- does not have. Identical reasoning, and identical mechanics, to 0042.
--
-- ══ THE TEMPLATE IS A SNAPSHOT SOURCE, NOT A LIVE PARENT ════════════════════
--
-- Every field the job copies — title, type, capacity, fee, format, team size —
-- is COPIED onto the occurrence at generation time. Editing the series changes
-- what FUTURE occurrences look like and touches no historical one. That is why
-- there is no foreign-key cascade of values and no "inherit from parent" read
-- path: an event that already happened, took registrations and possibly money
-- must never change because somebody retitled the series afterwards.
-- ============================================================================

-- weekly and monthly only. An enum rather than free text so adding a cadence
-- later is an ALTER TYPE rather than a data migration, and so a typo cannot
-- create a cadence nothing processes. Same reasoning as expense_cadence (0042).
do $$ begin
  create type public.event_cadence as enum ('weekly', 'monthly');
exception when duplicate_object then null; end $$;

create table if not exists public.event_series (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  branch_id   uuid not null,

  -- ── the recurrence ──────────────────────────────────────────────────────
  cadence     public.event_cadence not null,
  -- weekly: 0 = Sunday … 6 = Saturday, matching EXTRACT(dow) so the job's date
  -- arithmetic needs no lookup table. Null for a monthly series.
  weekday      smallint check (weekday is null or weekday between 0 and 6),
  -- monthly: 1–31, clamped to the month's last day by the job exactly as 0042
  -- clamps a day-31 expense into February. Null for a weekly series.
  day_of_month smallint check (day_of_month is null or day_of_month between 1 and 31),

  -- Local wall-clock start, in the TENANT's timezone. Stored as a `time`, not a
  -- timestamptz: "Tuesdays at 19:00" is a wall-clock arrangement that must stay
  -- at 19:00 across a DST change, not an absolute instant that drifts.
  start_time       time not null,
  duration_minutes integer not null check (duration_minutes between 15 and 1440),

  -- The next LOCAL date to generate for. Advanced by the job in SQL.
  next_run   date not null,
  -- Optional stop date: generation ceases after it. Null = runs indefinitely.
  until_date date,
  is_active  boolean not null default true,

  -- ── the snapshot the job copies onto each occurrence ────────────────────
  title             text not null check (length(btrim(title)) > 0),
  type              public.event_type not null,
  description       text,
  banner_url        text,
  capacity          integer check (capacity is null or capacity >= 1),
  entry_fee         numeric(10,2) not null default '0' check (entry_fee >= 0),
  tournament_format public.tournament_format,
  registration_mode public.event_registration_mode not null default 'solo',
  team_size         integer,

  created_by uuid references public.memberships(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_series_tenant_id_key unique (tenant_id, id),
  constraint event_series_branch_fk foreign key (tenant_id, branch_id)
    references public.branches(tenant_id, id) on delete restrict,

  -- Exactly the field the cadence needs, and not the other. Stated as an
  -- equivalence so a weekly series carrying a day_of_month — which nothing
  -- would read — cannot be written.
  constraint event_series_cadence_field check (
    (cadence = 'weekly')  = (weekday is not null)
    and (cadence = 'monthly') = (day_of_month is not null)
  ),

  -- The same two rules `events` enforces (0076/0079), restated here so a series
  -- cannot be configured to generate events that would violate them — the job
  -- would then fail every night with no way for a manager to see why.
  constraint event_series_tournament_format check (
    (type = 'tournament') = (tournament_format is not null)
  ),
  constraint event_series_team_size check (
    (registration_mode = 'team') = (team_size is not null)
    and (team_size is null or team_size between 2 and 20)
  )
);

-- THE job's only scan: active series whose next_run has arrived. Partial,
-- because an inactive series should not occupy an index the scheduler walks.
create index if not exists idx_event_series_due
  on public.event_series(next_run) where (is_active);
create index if not exists idx_event_series_tenant
  on public.event_series(tenant_id, created_at desc);

drop trigger if exists trg_event_series_updated on public.event_series;
create trigger trg_event_series_updated before update on public.event_series
  for each row execute function public.set_updated_at();

-- ── provenance on events ────────────────────────────────────────────────────
alter table public.events
  add column if not exists series_id uuid,
  -- The LOCAL date this occurrence represents. The idempotency key, and also
  -- what makes "which Tuesday was that?" answerable without timezone maths.
  add column if not exists occurrence_period date;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.events'::regclass and conname = 'events_series_fk'
  ) then
    alter table public.events
      add constraint events_series_fk foreign key (tenant_id, series_id)
      -- SET NULL, not CASCADE: deleting a series must never delete the events
      -- it produced. Those happened, took registrations and possibly money.
      -- The occurrence simply stops naming its origin.
      --
      -- The COLUMN LIST is load-bearing. A bare `on delete set null` on a
      -- composite key nulls EVERY referencing column — including tenant_id,
      -- which is NOT NULL — so deleting a series failed outright. Naming
      -- series_id restricts the nulling to the column that actually carries the
      -- reference. (Postgres 15+; this project runs 17.)
      references public.event_series(tenant_id, id) on delete set null (series_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.events'::regclass and conname = 'events_series_provenance'
  ) then
    -- "If you claim a series, say which period." Deliberately NOT an
    -- equivalence: when a series is deleted, series_id is set null and the
    -- occurrence keeps its period, which is real history — that Tuesday's class
    -- did happen on that date. An equivalence would make the FK's SET NULL
    -- violate this CHECK and block the delete entirely.
    alter table public.events
      add constraint events_series_provenance
      check (series_id is null or occurrence_period is not null);
  end if;
end $$;

-- THE IDEMPOTENCY GUARANTEE. One occurrence per series per period, enforced by
-- the database rather than by the job checking first.
create unique index if not exists idx_events_series_occurrence
  on public.events(series_id, occurrence_period)
  where (series_id is not null);

create index if not exists idx_events_series
  on public.events(tenant_id, series_id) where (series_id is not null);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- The same split `events` itself uses (0076): any active member may read, only
-- a manager may write. No public policy — a series is a scheduling artefact,
-- and the public sees the OCCURRENCES it generates, which are ordinary events
-- already covered by events_public_select.
alter table public.event_series enable row level security;

drop policy if exists event_series_select on public.event_series;
create policy event_series_select on public.event_series
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists event_series_manager_write on public.event_series;
create policy event_series_manager_write on public.event_series
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.event_series to arena_app;

comment on table public.event_series is
  'A recurring event/class template (M15 #8). The job scripts/run-recurring-events.ts copies its snapshot fields onto ordinary `events` rows; editing a series never alters an occurrence already generated. Idempotency is idx_events_series_occurrence, not an application check — the same design 0042 uses for recurring expenses.';

comment on column public.events.occurrence_period is
  'The LOCAL date (tenant timezone) this occurrence represents. Half of the unique key idx_events_series_occurrence that makes recurring generation idempotent and safe under concurrent jobs.';
