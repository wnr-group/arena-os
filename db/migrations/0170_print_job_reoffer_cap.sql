-- ============================================================================
-- Arena OS — 0170 cap duplicate re-offers of a cloud-print job
--
-- cloudprnt_poll (0149) re-offered any job that was `sent` within the last five
-- minutes, and cloudprnt_fetch let the device fetch it again without limit and
-- without counting it. If a printer printed a ticket but its confirmation was
-- lost, it printed a duplicate on every poll (every few seconds) for five minutes.
--
-- Now `attempts` counts every delivery of the bytes to the device (the first
-- fetch, and one re-fetch after a lost response), and a sent job is re-offered
-- only while attempts < 2. So a job whose confirmation is lost prints at most
-- twice; after that it stays `sent` and shows as stale in the queue for staff to
-- retry or cancel. A manual retry resets the count (see retryPrintJob).
--
-- Also an index so the retention sweep (lib/printing/retention.ts) can find old
-- finished jobs without scanning the table.
-- ============================================================================

create or replace function public.cloudprnt_poll(p_printer uuid, p_secret text, p_mac text, p_status text)
returns table(ok boolean, job_id uuid, media_type text)
language plpgsql security definer set search_path = public
as $$
declare pr public.printers;
begin
  pr := public._printer_for(p_printer, p_secret);
  if pr.id is null then
    return query select false, null::uuid, null::text;
    return;
  end if;
  update public.printers
     set last_seen_at = now(),
         device_mac = coalesce(nullif(p_mac,''), device_mac),
         last_status = nullif(left(p_status, 200), '')
   where id = pr.id;
  return query
    select true, j.id, pr.media_type
      from (select id from public.print_jobs
             where printer_id = pr.id
               and (status = 'pending'
                    or (status = 'sent' and attempts < 2 and sent_at > now() - interval '5 minutes'))
             order by (status = 'sent') desc, created_at
             limit 1) j
    union all
    select true, null::uuid, pr.media_type
     where not exists (select 1 from public.print_jobs
                        where printer_id = pr.id
                          and (status = 'pending'
                               or (status = 'sent' and attempts < 2 and sent_at > now() - interval '5 minutes')));
end $$;

-- Fetch: hand the job's bytes to the device. The first fetch marks it sent; one
-- more fetch is allowed (a lost response) and counts as the second delivery;
-- beyond that the device gets nothing.
create or replace function public.cloudprnt_fetch(p_printer uuid, p_secret text, p_job uuid)
returns bytea
language plpgsql security definer set search_path = public
as $$
declare pr public.printers; j public.print_jobs;
begin
  pr := public._printer_for(p_printer, p_secret);
  if pr.id is null then return null; end if;
  select * into j from public.print_jobs
   where id = p_job and printer_id = pr.id and status in ('pending','sent') for update;
  if j.id is null then return null; end if;
  if j.status = 'sent' and j.attempts >= 2 then return null; end if;
  update public.print_jobs
     set status = 'sent', sent_at = now(), attempts = attempts + 1
   where id = j.id;
  return j.payload;
end $$;

revoke all on function public.cloudprnt_poll(uuid, text, text, text) from public;
revoke all on function public.cloudprnt_fetch(uuid, text, uuid) from public;
grant execute on function public.cloudprnt_poll(uuid, text, text, text) to arena_app;
grant execute on function public.cloudprnt_fetch(uuid, text, uuid) to arena_app;

create index if not exists idx_print_jobs_prune
  on public.print_jobs(created_at)
  where status in ('printed','cancelled','failed');
