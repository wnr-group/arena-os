-- ============================================================================
-- Arena OS — 0087 staff waitlist promotion entry point (M15 #5 §7)
--
-- One SECURITY DEFINER entry point, so a manager can promote the next entrant
-- when a confirmed registrant is a no-show.
--
-- ══ WHY AN ENTRY POINT AND NOT A GRANT ══════════════════════════════════════
--
-- `promote_event_waitlist()` already exists (0081) and already does the whole
-- job correctly: FIFO by (created_at, id), re-reading occupancy on every
-- iteration, stopping at capacity, and promoting to `pending_payment` with a
-- 24-hour hold on a paid event rather than to `registered`. It is exactly what
-- this ticket needs, and it is deliberately NOT to be reimplemented.
--
-- But 0081 revoked it from `public` and never granted it to `arena_app`, on
-- purpose: it takes a bare event id, performs no authorization of its own, and
-- is only ever called from inside another SECURITY DEFINER function that has
-- already established who the caller is. Granting it directly to the app role
-- would hand every signed-in user of every tenant the ability to promote
-- anybody's waitlist by guessing an event id.
--
-- So this adds the missing half — the authorising wrapper — following the shape
-- 0081's own entry points use: SECURITY DEFINER, authorises from the SESSION
-- rather than from an argument, and returns a value rather than raising.
--
-- ══ AUTHORIZATION ═══════════════════════════════════════════════════════════
--
-- `auth_is_manager(tenant_id)` of the EVENT'S OWN tenant, read from the event
-- row rather than taken from the caller. A manager of tenant A therefore cannot
-- promote tenant B's waitlist even with a valid tenant B event id: the check is
-- against the row's tenant, not against anything supplied.
--
-- A non-manager and a non-existent event return the SAME 0, so probing event
-- ids reveals nothing — the identical-answer discipline
-- cancel_event_registration() applies for the same reason.
--
-- ══ CONCURRENCY ════════════════════════════════════════════════════════════
--
-- The `for update` on `events` is taken HERE, before promote_event_waitlist()
-- reads occupancy, so two managers clicking Promote at the same moment
-- serialise on the event row. The second one re-reads occupancy after the first
-- has committed, finds the place taken, and promotes nobody. That is what makes
-- "two staff cannot consume the same spot" a database property rather than a
-- hope about timing.
-- ============================================================================

create or replace function public.promote_event_waitlist_as_staff(p_event_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_lock   uuid;
begin
  select e.tenant_id into v_tenant from public.events e where e.id = p_event_id;
  if not found then return 0; end if;

  -- The event's OWN tenant decides, never a caller-supplied one.
  if not public.auth_is_manager(v_tenant) then return 0; end if;

  -- Serialise promotion per event. promote_event_waitlist() re-reads occupancy
  -- inside its loop, so holding this makes the read-decide-write atomic across
  -- concurrent callers.
  select e.id into v_lock from public.events e where e.id = p_event_id for update;

  return public.promote_event_waitlist(p_event_id);
end;
$$;

revoke all on function public.promote_event_waitlist_as_staff(uuid) from public;
grant execute on function public.promote_event_waitlist_as_staff(uuid) to arena_app;

comment on function public.promote_event_waitlist_as_staff(uuid) is
  'Manager-authorised waitlist promotion for no-show recovery (M15 #5). Wraps promote_event_waitlist() (0081) — which owns every capacity, FIFO and paid-event rule — with an auth_is_manager() check against the EVENT''s tenant and a per-event lock. Returns the number promoted; returns 0 for a non-manager and for an unknown event alike, so event ids cannot be probed.';
