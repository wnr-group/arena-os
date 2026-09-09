-- ============================================================================
-- Arena OS — 0098 event matches (M15 #6)
--
-- One table. The bracket ENGINE is pure TypeScript (lib/events/bracket.ts);
-- this is only where its output is kept and where results are recorded.
--
-- ══ THE PARTICIPANT IS A REGISTRATION ═══════════════════════════════════════
--
-- `participant_a` / `participant_b` are `event_registrations` ids, not customer
-- ids and not team ids. That is the identity M15 already uses for "somebody
-- entered this event", and it is the one the check-in list (M15 #5) returns, so
-- no participant data is duplicated here: a match names two registrations, and
-- the registration already carries the customer, the team and the payment.
--
-- It also makes TEAM events work with no special case. A team enters as ONE
-- registration held by the captain (0091), so a team match is two registration
-- ids exactly like a solo match, and the team relationship stays intact through
-- event_registrations.team_id → event_teams → event_team_members.
--
-- ══ COORDINATES, AND WHY THEY ARE UNIQUE ════════════════════════════════════
--
-- A match is located by (side, round, position). The engine emits those, the
-- service resolves them to ids, and `event_matches_coordinate_key` guarantees
-- one match per coordinate per event — which is what makes generation
-- IDEMPOTENT at the database level rather than by an application check: a
-- second generation attempt collides instead of silently doubling the draw.
--
-- ══ NEXT-MATCH POINTERS ═════════════════════════════════════════════════════
--
-- `winner_next_match_id` / `winner_next_slot` and `loser_next_match_id` /
-- `loser_next_slot` are the topology, written once at generation. Advancement
-- then follows a pointer instead of recomputing bracket maths at result time —
-- so a winner cannot land in the wrong slot, because no arithmetic happens on
-- that path at all.
--
-- The loser pointer is null everywhere except a double-elimination winners
-- bracket (and the grand final, which routes into the reset). A null loser
-- pointer means eliminated, which is the correct reading in every other format.
-- ============================================================================

do $$ begin
  create type public.event_match_side as enum
    ('winners', 'losers', 'final', 'round_robin', 'points');
exception when duplicate_object then null; end $$;

-- pending    at least one participant is undetermined. Not scoreable.
-- ready      both participants known (or, for a points card, the one). Scoreable.
-- completed  a result is recorded.
-- bye        one participant, no opponent, already advanced by the generator.
--            Never scoreable — there is nothing to play.
-- void       structurally present but will not be played. The only user is the
--            double-elimination grand-final RESET, which exists in the draw
--            from the start and is voided the moment the winners-bracket
--            champion takes the first grand final. Keeping the row and marking
--            it void is what lets the topology stay static.
do $$ begin
  create type public.event_match_status as enum
    ('pending', 'ready', 'completed', 'bye', 'void');
exception when duplicate_object then null; end $$;

create table if not exists public.event_matches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  event_id   uuid not null,

  side     public.event_match_side not null,
  round    integer not null check (round >= 1),
  position integer not null check (position >= 0),

  -- event_registrations ids. Null while undetermined.
  participant_a uuid,
  participant_b uuid,

  status public.event_match_status not null default 'pending',

  -- Non-negative whole numbers; the engine's decideWinner() enforces the same
  -- rule before this is ever reached, and the CHECK is what makes it true of
  -- the stored row regardless of who wrote it.
  score_a integer check (score_a is null or score_a >= 0),
  score_b integer check (score_b is null or score_b >= 0),

  winner uuid,

  -- The topology, written at generation. See the header.
  winner_next_match_id uuid references public.event_matches(id) on delete set null,
  winner_next_slot     text check (winner_next_slot in ('a', 'b')),
  loser_next_match_id  uuid references public.event_matches(id) on delete set null,
  loser_next_slot      text check (loser_next_slot in ('a', 'b')),

  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint event_matches_tenant_id_key unique (tenant_id, id),

  -- Tenant-safe composite FKs. A match can never point at another tenant's
  -- event, and never at a registration belonging to a different tenant — the
  -- combination is unrepresentable rather than merely rejected in code.
  constraint event_matches_event_fk foreign key (tenant_id, event_id)
    references public.events(tenant_id, id) on delete cascade,
  constraint event_matches_a_fk foreign key (tenant_id, participant_a)
    references public.event_registrations(tenant_id, id) on delete restrict,
  constraint event_matches_b_fk foreign key (tenant_id, participant_b)
    references public.event_registrations(tenant_id, id) on delete restrict,
  constraint event_matches_winner_fk foreign key (tenant_id, winner)
    references public.event_registrations(tenant_id, id) on delete restrict,

  -- ONE match per coordinate. The idempotency guarantee for generation.
  constraint event_matches_coordinate_key unique (event_id, side, round, position),

  -- Nobody plays themselves. A structural impossibility, not a code convention.
  constraint event_matches_distinct check (
    participant_a is null or participant_b is null or participant_a <> participant_b
  ),

  -- A winner must be one of the two participants. This is what stops a caller
  -- naming an arbitrary registration as the victor even if every layer above
  -- were bypassed.
  constraint event_matches_winner_is_participant check (
    winner is null or winner = participant_a or winner = participant_b
  ),

  -- A completed match has a timestamp and a score for A; a match that is not
  -- completed has neither a winner nor a completion time. Stated as an
  -- equivalence so half-finished rows cannot be written.
  constraint event_matches_completion check (
    (status = 'completed') = (completed_at is not null)
    and (status = 'completed' or winner is null)
    and (status <> 'completed' or score_a is not null)
  ),

  -- A slot is named exactly when the pointer it belongs to is set.
  constraint event_matches_winner_route check (
    (winner_next_match_id is null) = (winner_next_slot is null)
  ),
  constraint event_matches_loser_route check (
    (loser_next_match_id is null) = (loser_next_slot is null)
  )
);

-- THE bracket read: every match of one event, in draw order.
create index if not exists idx_event_matches_event
  on public.event_matches(event_id, side, round, position);
create index if not exists idx_event_matches_tenant on public.event_matches(tenant_id);
-- Advancement follows these two pointers, and the standings reader walks
-- participants; both are indexed so a large draw does not sequential-scan.
create index if not exists idx_event_matches_winner_next
  on public.event_matches(winner_next_match_id) where (winner_next_match_id is not null);
create index if not exists idx_event_matches_loser_next
  on public.event_matches(loser_next_match_id) where (loser_next_match_id is not null);
create index if not exists idx_event_matches_participants
  on public.event_matches(event_id, participant_a, participant_b);

drop trigger if exists trg_event_matches_updated on public.event_matches;
create trigger trg_event_matches_updated before update on public.event_matches
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- The same split events and event_registrations use (0088, 0091): any active
-- member of the tenant may READ the draw — a cashier at the desk being asked
-- "who's on next?" needs it — and only a manager may WRITE. Generation and
-- score entry are manager actions, and auth_is_manager() is the database half
-- of the requireManager() in the server actions.
--
-- There is deliberately NO customer or public policy. Public bracket viewing is
-- not in this ticket; when it lands it gets its own policy, written for what it
-- actually needs to expose.
alter table public.event_matches enable row level security;

drop policy if exists event_matches_select on public.event_matches;
create policy event_matches_select on public.event_matches
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists event_matches_manager_write on public.event_matches;
create policy event_matches_manager_write on public.event_matches
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.event_matches to arena_app;

comment on table public.event_matches is
  'One match of an event competition (M15 #6). Participants are event_registrations ids — a team enters as one registration, so team and solo matches have the same shape. Located by (side, round, position), unique per event, which is what makes bracket generation idempotent. Winner/loser next-match pointers are the topology, written once at generation so advancement follows a pointer rather than recomputing bracket maths.';
