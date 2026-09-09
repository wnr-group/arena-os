-- ============================================================================
-- Arena OS — 0099 public live bracket (M15 #7)
--
-- Spectator access to a running tournament: the draw, the scores, the
-- standings. Read-only, and nothing else.
--
-- ══ 1. VISIBILITY HAS TO WIDEN, AND EXACTLY HOW FAR ═════════════════════════
--
-- 0089 made two statuses public — `published` and `registration_open` — because
-- it was written for a LISTING of events people can still enter. A live bracket
-- is the opposite case: it only becomes interesting once the tournament is
-- running, which is `in_progress`, and it must survive `completed` so the final
-- result stays readable after the last match.
--
-- So this widens the policy to "everything except draft and cancelled":
--
--     draft              NEVER. The venue's private working copy.
--     cancelled          NEVER. It is not happening.
--     published          public (unchanged)
--     registration_open  public (unchanged)
--     full               public — entries closed, the event is still real
--     in_progress        public — this is the case the whole ticket exists for
--     completed          public — the result is the point
--
-- ── This does NOT change what the listing shows ─────────────────────────────
--
-- getPublicEvents() and getPublicEventById() (lib/events/public.ts) both carry
-- their own `inArray(status, PUBLIC_EVENT_STATUSES)` filter, so the listing and
-- the event detail page keep showing only announced and open events. The policy
-- is the OUTER BOUND — what a stranger could reach at most — and the readers
-- narrow it further for their own purposes. Widening the bound therefore makes
-- the live page reachable by link without putting a finished tournament back
-- into the "what's on" list.
--
-- 0089's reasoning for putting the status test in the policy rather than only
-- in a reader stands unchanged: a future reader that forgets its filter still
-- cannot serve a draft.
--
-- ══ 2. MATCHES ARE PUBLIC, REGISTRATIONS ARE NOT ════════════════════════════
--
-- `event_matches` (0098) holds registration ids, scores and a winner — nothing
-- private — so it gets a public SELECT policy scoped to publicly-visible events
-- of the pinned tenant.
--
-- `event_registrations` gets NOTHING. It carries `paid_amount`,
-- `payment_reference`, `payment_hold_expires_at`, `refund_required` and
-- `check_in_token` — a bearer credential that would let a stranger check
-- somebody in. Granting a public read on that table to resolve display names
-- would be trading the entire payment and check-in surface for a caption.
--
-- Instead `public_event_participants()` below returns ONLY (registration id,
-- display name), for only the people actually drawn into the bracket, as a
-- SECURITY DEFINER function — the same shape public_event_teams() and
-- public_event_taken_counts() already use (0091).
-- ============================================================================

-- ── 1. widen the event policy ───────────────────────────────────────────────
drop policy if exists events_public_select on public.events;
create policy events_public_select on public.events
  for select using (
    tenant_id = public.current_public_tenant_id()
    and status not in ('draft', 'cancelled')
  );

-- ── 2. public read of the draw ──────────────────────────────────────────────
--
-- Scoped twice: the tenant must be the one withPublicTenant() pinned from the
-- subdomain, AND the parent event must itself be publicly visible. A match of a
-- draft event is unreachable even though the match row carries nothing secret,
-- because the existence of the draw would disclose the event.
--
-- No recursion risk: `events_public_select` does not reference event_matches.
drop policy if exists event_matches_public_select on public.event_matches;
create policy event_matches_public_select on public.event_matches
  for select using (
    tenant_id = public.current_public_tenant_id()
    and exists (
      select 1
        from public.events e
       where e.id = event_matches.event_id
         and e.tenant_id = event_matches.tenant_id
         and e.status not in ('draft', 'cancelled')
    )
  );

-- Deliberately NO public insert/update/delete policy of any kind. A spectator
-- reads the bracket; nothing on the public path can write a score, a winner, a
-- participant or a match. `event_matches_manager_write` (0098) remains the only
-- write policy, and it requires auth_is_manager().

-- ── 3. participant display names, and nothing else ──────────────────────────
--
-- Returns one row per registration that actually APPEARS in the draw. Somebody
-- who registered and never checked in is not in the bracket and is therefore
-- not named here — the function cannot be used to enumerate a guest list.
--
-- The tenant comes from `current_public_tenant_id()`, the GUC withPublicTenant()
-- sets from the subdomain, so it is never taken from a caller. A cross-tenant
-- event id returns zero rows rather than an error.
--
-- SECURITY DEFINER because it reads `event_registrations` and `customers`,
-- neither of which the public role may touch — which is the entire point: the
-- private tables stay closed and this narrow projection is the only way out.
create or replace function public.public_event_participants(p_event_id uuid)
returns table (registration_id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select r.id,
         -- A team enters as one participant, so the TEAM's name is the
         -- competitor; a solo entry shows the person's name. 'Entrant' when a
         -- customer record carries none, so a bracket cell is never blank.
         coalesce(nullif(btrim(t.name), ''), nullif(btrim(c.name), ''), 'Entrant')
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
  'Display names for the participants drawn into one public event''s bracket (M15 #7). SECURITY DEFINER so the public path never touches event_registrations, which holds payment references and check-in tokens. Returns only (registration_id, display_name), only for registrations that appear in event_matches, and only for an event of the tenant pinned by withPublicTenant().';

-- ── 4. the index the spectator poll rides on ────────────────────────────────
--
-- 0098 already indexes (event_id, side, round, position), which is exactly the
-- live page's read: every match of one event in draw order. Stated here so the
-- polling cost is a documented decision rather than an accident — a spectator
-- refresh is one index range scan plus one function call, not a table scan.
