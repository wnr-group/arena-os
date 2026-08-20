-- Arena OS — 0008: make cross-tenant customer links structurally impossible

-- Guarded rather than dropped-and-added: once the composite FKs below (and in
-- 0012 / 0014 / 0026) exist they depend on this constraint, so a bare DROP
-- fails with 'other objects depend on it' on any re-run.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.customers'::regclass
       and conname  = 'customers_tenant_id_key'
  ) then
    alter table public.customers
      add constraint customers_tenant_id_key unique (tenant_id, id);
  end if;
end $$;

alter table public.bookings
  drop constraint if exists bookings_customer_id_fkey;
alter table public.bookings
  drop constraint if exists bookings_customer_tenant_fkey;
alter table public.bookings
  add constraint bookings_customer_tenant_fkey
  foreign key (tenant_id, customer_id)
  references public.customers(tenant_id, id)
  on delete set null (customer_id);
