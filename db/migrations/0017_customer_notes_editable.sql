-- Arena OS — 0009: customer notes become editable

alter table public.customer_notes
  add column if not exists updated_at timestamptz;
update public.customer_notes set updated_at = created_at where updated_at is null;
alter table public.customer_notes alter column updated_at set default now();
alter table public.customer_notes alter column updated_at set not null;

drop trigger if exists trg_customer_notes_updated on public.customer_notes;
create trigger trg_customer_notes_updated before update on public.customer_notes
  for each row execute function public.set_updated_at();
  
alter table public.customer_notes
  drop constraint if exists customer_notes_customer_id_fkey;
alter table public.customer_notes
  drop constraint if exists customer_notes_customer_tenant_fkey;
alter table public.customer_notes
  add constraint customer_notes_customer_tenant_fkey
  foreign key (tenant_id, customer_id)
  references public.customers(tenant_id, id)
  on delete cascade;
