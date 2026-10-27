-- A station's availability changes must keep following the events that hold it.
--
-- 0130's trigger (apply_branch_event_blocks) added a block when a station became
-- bookable inside a live BRANCH event, and nothing else:
--
--   * a 'specific' event never inherited — publish it while a selected station was in
--     maintenance and, once repaired, that station was bookable straight through the
--     event (resolveTargets only blocks 'available' stations at sync time);
--   * a station moved to another branch kept the blocks of its OLD branch's events,
--     holding time for an event that no longer has anything to do with it, while the
--     new branch's events were handled by the insert half only.
--
-- Both are closed here, in the database, for the same reason 0130 did it there: any
-- path that changes a resource has to be covered, not just the ones the app remembers.
create or replace function public.apply_branch_event_blocks()
returns trigger language plpgsql as $$
begin
  -- Moved branch: it no longer belongs to the events of the branch it left, whatever
  -- their scope (resolveTargets would drop it on the next sync anyway).
  if tg_op = 'UPDATE' and new.branch_id is distinct from old.branch_id then
    delete from public.booking_slots bs
     using public.events e
     where bs.resource_id = new.id
       and bs.event_id is not null
       and e.id = bs.event_id
       and e.tenant_id = bs.tenant_id
       and e.branch_id <> new.branch_id;
  end if;

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
    and (
      e.resource_scope = 'branch'
      -- A 'specific' event holds the stations it SELECTED, including one that was
      -- unavailable when it was synced.
      or (e.resource_scope = 'specific'
          and exists (
            select 1 from public.event_resources er
             where er.event_id = e.id and er.tenant_id = e.tenant_id and er.resource_id = new.id))
    )
    -- The same statuses lib/events/resource-blocks.ts treats as blocking.
    -- Stated in both places on purpose: this trigger is the last line of
    -- defence and must not depend on the application agreeing with it.
    and e.status in ('published', 'registration_open', 'full', 'in_progress')
    and e.ends_at > now()
  on conflict do nothing;

  return new;
end;
$$;
