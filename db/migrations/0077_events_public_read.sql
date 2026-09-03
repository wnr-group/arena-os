-- ============================================================================
-- Arena OS — 0077 public event visibility (M15 #2).
--
-- The public events listing, the event detail page and the homepage promotion
-- all read `events` with NO session. This adds the one policy that makes that
-- possible, and — the point of the file — encodes WHICH events a stranger may
-- see in the database rather than in a WHERE clause someone can forget.
--
-- ── Visibility is a lifecycle question, not a capacity one ──────────────────
--
-- Exactly two statuses are public:
--
--     published          announced, registration not yet open
--     registration_open  accepting entrants
--
-- and five are not: draft (the venue's private working copy), full,
-- in_progress, completed and cancelled. `full` deserves a note because it is
-- the one people get wrong: an event is hidden when it is full because the
-- MANAGER moved it to `full`, a lifecycle act — not because a capacity count
-- happened to reach a number. Capacity and visibility are separate concerns
-- and this policy only knows about the former.
--
-- Modelled on menu_items_public_select (0056), which pairs the tenant pin with
-- a status filter in exactly this way. Putting the status test HERE rather than
-- only in lib/events/public.ts means a future reader that forgets `.where(
-- inArray(status, ...))` still cannot return a draft to a stranger — the
-- database simply has no such row to give it.
--
-- current_public_tenant_id() reads the `app.public_tenant_id` GUC that
-- withPublicTenant() sets (db/index.ts). It is never taken from the browser:
-- the tenant is resolved from the subdomain through public_tenant_by_slug()
-- (0022) before any of this runs.
-- ============================================================================

drop policy if exists events_public_select on public.events;
create policy events_public_select on public.events
  for select using (
    tenant_id = public.current_public_tenant_id()
    and status in ('published', 'registration_open')
  );

-- No public INSERT/UPDATE/DELETE policy of any kind, deliberately. A visitor
-- reads events and nothing more; registration (M15 #3) will add its own table
-- with its own narrowly-scoped write policy rather than opening this one.

-- Partial index matching the policy's own predicate — the public listing and
-- the homepage promotion both filter to these two statuses and order by
-- starts_at, so this is the index they actually use.
create index if not exists idx_events_public_upcoming
  on public.events(tenant_id, starts_at)
  where status in ('published', 'registration_open');
