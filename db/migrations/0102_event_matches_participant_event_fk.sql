-- ============================================================================
-- Arena OS — 0102 event_matches: a drawn participant must belong to the SAME
-- event as the match that draws them.
--
-- ── The hole this closes ────────────────────────────────────────────────────
--
-- 0098 constrained the two participant slots with
--
--     foreign key (tenant_id, participant_a) references event_registrations
--
-- which proves the registration exists and belongs to this tenant, and stops
-- there. It never proves the registration is an entry in THIS event. A match of
-- event X could therefore, at the schema level, name a registration of event Y
-- belonging to the same venue. Nothing in the application does that — the draw
-- is built from listCheckedInParticipants(eventId) and advancement only copies
-- ids that are already in the bracket — but "the code is careful" is exactly
-- the guarantee this codebase prefers to state as a constraint.
--
-- 0091 already makes the same argument one table over, and in the same words:
-- event_registrations_team_fk carries (tenant_id, event_id, team_id) "so the
-- registration, its team and its event are provably the same event". This is
-- that rule applied to the participant slots, which were the one place in the
-- events schema still relying on three columns' worth of intent with only two
-- columns of enforcement.
--
-- ── Why it matters, concretely ──────────────────────────────────────────────
--
-- Both bracket readers resolve display names and seeding from a SECOND query
-- that filters `r.event_id = <this event>` — participantNames() on the staff
-- side, public_event_participants() (0101) on the public one. A cross-event
-- participant id is in the match rows but not in that query's result, and
-- computeStandings() builds its table only from the list it is handed. The
-- readers now degrade such an id to an 'Entrant' row rather than dropping the
-- competitor out of the standings entirely, but degrading gracefully is the
-- second line. This is the first: the row cannot be written.
--
-- ── Shape ───────────────────────────────────────────────────────────────────
--
-- The FK needs a matching unique key on the referenced side, so
-- event_registrations gains `unique (tenant_id, event_id, id)` — the exact
-- counterpart of event_teams_event_id_key (0091), named to match.
--
-- MATCH SIMPLE (the default) is what makes an undecided slot still legal: with
-- participant_a null the constraint is not enforced at all, so a pending match,
-- a bye and a points card with no opponent all pass unchanged. tenant_id and
-- event_id are NOT NULL, so a null can only ever come from the slot itself.
--
-- `winner` is deliberately NOT re-pointed. event_matches_winner_is_participant
-- already requires `winner = participant_a or winner = participant_b`, so once
-- both slots are pinned to this event the winner is transitively pinned too.
-- A third redundant unique-index lookup on every write buys nothing.
--
-- `on delete restrict` is carried over unchanged: a registration that appears
-- in a draw cannot be deleted out from under it.
--
-- Idempotent in the same style as 0091's guarded constraints, so a re-run or a
-- partially-applied environment settles rather than aborts.
-- ============================================================================

-- ── 1. the referenced key ───────────────────────────────────────────────────
do $$ begin
  alter table public.event_registrations
    add constraint event_registrations_event_id_key unique (tenant_id, event_id, id);
exception when duplicate_table or duplicate_object then null; end $$;

-- ── 2. re-point the two participant slots ───────────────────────────────────
--
-- Dropped and re-added rather than added alongside: leaving the two-column FK
-- in place would mean every insert paid for two constraint checks that say the
-- same thing, and would leave a weaker rule on the table for a future reader to
-- mistake for the real one.
alter table public.event_matches
  drop constraint if exists event_matches_a_fk,
  drop constraint if exists event_matches_b_fk;

do $$ begin
  alter table public.event_matches
    add constraint event_matches_a_fk
      foreign key (tenant_id, event_id, participant_a)
      references public.event_registrations(tenant_id, event_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.event_matches
    add constraint event_matches_b_fk
      foreign key (tenant_id, event_id, participant_b)
      references public.event_registrations(tenant_id, event_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

comment on constraint event_matches_a_fk on public.event_matches is
  'Slot A names a registration of THIS event, of THIS tenant (0102). Three columns, like event_registrations_team_fk, so "same event" is proved rather than assumed. MATCH SIMPLE: an undecided slot is null and unconstrained.';

comment on constraint event_matches_b_fk on public.event_matches is
  'Slot B names a registration of THIS event, of THIS tenant (0102). Null for a bye, a points card, or an undecided slot.';
