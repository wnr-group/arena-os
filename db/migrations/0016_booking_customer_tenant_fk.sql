-- Arena OS — 0008: make cross-tenant customer links structurally impossible

alter table public.customers
  drop constraint if exists customers_tenant_id_key;
alter table public.customers
  add constraint customers_tenant_id_key unique (tenant_id, id);

alter table public.bookings
  drop constraint if exists bookings_customer_id_fkey;
alter table public.bookings
  drop constraint if exists bookings_customer_tenant_fkey;
alter table public.bookings
  add constraint bookings_customer_tenant_fkey
  foreign key (tenant_id, customer_id)
  references public.customers(tenant_id, id)
  on delete set null (customer_id);
