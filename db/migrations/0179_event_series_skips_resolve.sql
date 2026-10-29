-- Let a manager resolve a skipped recurring-event occurrence (create it anyway,
-- or dismiss it). 0164 granted read only; the job writes as the owner role.
drop policy if exists event_series_skips_delete on public.event_series_skips;
create policy event_series_skips_delete on public.event_series_skips
  for delete using (public.auth_is_manager(tenant_id));

grant delete on public.event_series_skips to arena_app;
