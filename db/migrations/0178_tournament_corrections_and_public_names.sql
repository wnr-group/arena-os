-- ============================================================================
-- Arena OS — 0178 tournaments: forfeit marker and public bracket privacy.
--
-- 1. event_matches.result_kind: 'played' | 'forfeit'. A forfeit is stored 0-0
--    with the opponent as winner, so the staff board and the table can say
--    "forfeit" instead of showing an invented scoreline.
--
-- 2. The PUBLIC live bracket showed every solo entrant's full name with no
--    opt-in (public_event_participants(), 0137) — a problem for anyone, and
--    more so if minors can enter. It now returns, for a solo entry:
--      * the name the customer chose to show (event_registrations.
--        public_display_name, set through set_event_public_name()), else
--      * their INITIALS ("P. S."), never the stored name.
--    A team still shows its team name, which the captain chose and which
--    public_event_teams() already exposes. Staff screens are unchanged.
-- ============================================================================

alter table public.event_matches
  add column if not exists result_kind text not null default 'played';

do $$ begin
  alter table public.event_matches
    add constraint event_matches_result_kind check (result_kind in ('played', 'forfeit'));
exception when duplicate_object then null; end $$;

alter table public.event_registrations
  add column if not exists public_display_name text;

do $$ begin
  alter table public.event_registrations
    add constraint event_registrations_public_name_len check (
      public_display_name is null
      or (length(btrim(public_display_name)) between 1 and 40)
    );
exception when duplicate_object then null; end $$;

-- A customer sets (or clears, with null/blank) the name shown publicly for
-- THEIR OWN registration. No customer id parameter: it is read from the session.
create or replace function public.set_event_public_name(p_registration_id uuid, p_name text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_name     text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_customer is null then return 'not_signed_in'; end if;
  if v_name is not null and length(v_name) > 40 then return 'too_long'; end if;

  update public.event_registrations
     set public_display_name = v_name
   where id = p_registration_id and customer_id = v_customer;
  if not found then return 'not_found'; end if;
  return 'saved';
end;
$$;
revoke all on function public.set_event_public_name(uuid, text) from public;
grant execute on function public.set_event_public_name(uuid, text) to arena_app;

drop function if exists public.public_event_participants(uuid);

create function public.public_event_participants(p_event_id uuid)
returns table (registration_id uuid, display_name text, seed integer)
language sql stable security definer set search_path = public
as $$
  select r.id,
         coalesce(
           nullif(btrim(t.name), ''),
           nullif(btrim(r.public_display_name), ''),
           (select nullif(string_agg(upper(left(w, 1)) || '.', ' '), '')
              from regexp_split_to_table(btrim(coalesce(c.name, '')), '\s+') as w
             where w <> ''),
           'Entrant'
         ),
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
  'Display names and seed positions for the participants drawn into one public event''s bracket. A team shows its team name; a solo entry shows the name the customer opted to display, else initials only (0178). Same visibility rules as before (0137).';
