-- Past-booking entry (M28) is a bookkeeping back-fill: the manager is recording
-- a session that already happened, so a clash with another record must not stop
-- the entry. Slots of such a booking are flagged and left out of the
-- booking_slots_no_overlap exclusion constraint. They stay `active` (invoicing
-- and reports read active slots), they simply neither block nor are blocked by
-- another slot. Non-backdated slots are unaffected: the flag defaults to false.
alter table public.booking_slots
  add column if not exists backdated boolean not null default false;

alter table public.booking_slots drop constraint if exists booking_slots_no_overlap;
alter table public.booking_slots
  add constraint booking_slots_no_overlap
    exclude using gist (
      resource_id with =,
      tstzrange(starts_at, ends_at) with &&
    ) where (active and not backdated);
