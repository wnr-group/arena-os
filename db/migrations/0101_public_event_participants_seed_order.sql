-- ============================================================================
-- Arena OS — 0101 public_event_participants: hand back the SEED, not just the
-- name, so the public standings tiebreak can honour the documented rule.
--
-- ── The bug this fixes ──────────────────────────────────────────────────────
--
-- computeStandings() (lib/events/bracket.ts) takes a seedOrder and uses it as
-- the final total-order tiebreak, documented as "an unbroken tie resolves to
-- whoever checked in first". The public live page (lib/events/public-live.ts)
-- had no way to honour that: 0099 deliberately keeps the public path off
-- event_registrations entirely — that table holds payment references and
-- check-in tokens — so it reconstructed an order by walking the match rows.
--
-- That is not arrival order. generateRoundRobin's circle method pairs seed 0
-- against the LAST seed, seed 1 against the second-last, and so on, so walking
-- the rows yields 0, last, 1, last-1, … Competitors level on wins, point
-- difference and points-for were therefore ranked in an order nobody could
-- explain, and one that contradicted the rule the header states. (The staff
-- reader had the same defect and is fixed in application code, where it CAN
-- read event_registrations directly.)
--
-- SCOPE, precisely: only ROUND ROBIN was ever mis-ranked. generatePoints emits
-- one card per participant at position = i in seeded order, and both readers
-- sort by (side, round, position), so walking the match rows of a `points`
-- event already reproduced the seeding exactly. This is stated so nobody goes
-- hunting for a points defect that never existed — and the fix is applied to
-- both formats anyway, because one rule that is true by construction beats two
-- that agree by coincidence.
--
-- ── Why a `seed` column rather than just an ORDER BY ────────────────────────
--
-- An ORDER BY inside a set-returning SQL function is not a contract: Postgres
-- may inline the function into the calling query, and a caller with no ORDER
-- BY of its own is then relying on planner behaviour for its row sequence.
-- That is exactly the kind of "works today" ordering this migration exists to
-- stop depending on. Returning the seed as a value makes the caller sort
-- explicitly, so the order survives inlining, a parallel plan, or any future
-- rewrite of the query around it.
--
-- ── What it does NOT expose ─────────────────────────────────────────────────
--
-- The seed is a 1-based ordinal, never the timestamp it derives from: knowing
-- somebody was third to arrive is not knowing when they arrived. The draw
-- already reveals seeding anyway — a bracket pairs seed 1 with the last seed
-- in plain sight — so this adds no fact a spectator could not already read off
-- the page. Every other guard from 0099 is carried over unchanged: the tenant
-- pin, the draft/cancelled exclusion, and the `exists` that limits rows to
-- registrations actually drawn into the bracket.
--
-- The ordering is the SAME rule seedParticipants() applies in bracket.ts and
-- listCheckedInParticipants() orders by: checked_in_at ascending, ties broken
-- on the registration id, which is unique and therefore a total order.
-- `nulls last` only guards the impossible — a drawn participant was checked in
-- by definition — but is stated so the intent survives a future edit.
--
-- DROP then CREATE, not CREATE OR REPLACE: the result type gains a column, and
-- replace cannot change a function's result type. The grants 0099 set are
-- dropped with it, so they are restated below.
-- ============================================================================

drop function if exists public.public_event_participants(uuid);

create function public.public_event_participants(p_event_id uuid)
returns table (registration_id uuid, display_name text, seed integer)
language sql stable security definer set search_path = public
as $$
  select r.id,
         -- A team enters as one participant, so the TEAM's name is the
         -- competitor; a solo entry shows the person's name. 'Entrant' when a
         -- customer record carries none, so a bracket cell is never blank.
         coalesce(nullif(btrim(t.name), ''), nullif(btrim(c.name), ''), 'Entrant'),
         row_number() over (order by r.checked_in_at asc nulls last, r.id asc)::int
    from public.event_registrations r
    join public.events e     on e.id = r.event_id
    join public.customers c  on c.id = r.customer_id
    left join public.event_teams t on t.id = r.team_id
   where r.event_id = p_event_id
     and e.tenant_id = public.current_public_tenant_id()
     and e.status not in ('draft', 'cancelled')
     and exists (
       select 1 from public.event_matches m
        where m.event_id = p_event_id
          and (m.participant_a = r.id or m.participant_b = r.id)
     );
$$;

revoke all on function public.public_event_participants(uuid) from public;
grant execute on function public.public_event_participants(uuid) to arena_app;

comment on function public.public_event_participants(uuid) is
  'Display names and seed positions for the participants drawn into one public event''s bracket (M15 #7). SECURITY DEFINER so the public path never touches event_registrations, which holds payment references and check-in tokens. Returns only (registration_id, display_name, seed), only for registrations that appear in event_matches, and only for an event of the tenant pinned by withPublicTenant(). `seed` is the 1-based arrival position — checked_in_at ascending, ties on registration id — matching seedParticipants() in lib/events/bracket.ts, so the public standings tiebreak can resolve a tie the way the documented rule says it does (0101).';
