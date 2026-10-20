-- Arena OS — 0145 revoke PUBLIC execute on the 0127 event-registration functions.
--
-- Postgres grants EXECUTE to PUBLIC on every new function, and 0127 granted to
-- arena_app without revoking that default. These are SECURITY DEFINER (RLS is
-- off inside them), so only the application role may call them. 0127 has
-- shipped on this chain, so the fix is a new migration rather than an edit.

revoke all on function public.claim_event_registration(uuid, text) from public;
revoke all on function public.join_event_team(uuid)                from public;
revoke all on function public.cancel_event_registration(uuid)      from public;
revoke all on function public.public_event_taken_counts(uuid)      from public;
revoke all on function public.public_event_teams(uuid)             from public;
revoke all on function public.my_event_participation(uuid)         from public;

-- Re-state the grant so the end state is explicit regardless of prior order.
grant execute on function public.claim_event_registration(uuid, text) to arena_app;
grant execute on function public.join_event_team(uuid)                to arena_app;
grant execute on function public.cancel_event_registration(uuid)      to arena_app;
grant execute on function public.public_event_taken_counts(uuid)      to arena_app;
grant execute on function public.public_event_teams(uuid)             to arena_app;
grant execute on function public.my_event_participation(uuid)         to arena_app;
