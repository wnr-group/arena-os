-- Arena OS — 0016: make cross-tenant customer links structurally impossible

-- 1. Drop the existing FK first because it depends on
--    customers_tenant_id_key
alter table public.bookings
  drop constraint if exists bookings_customer_id_fkey;

alter table public.bookings
  drop constraint if exists bookings_customer_tenant_fkey;


-- 2. Now it is safe to replace the old unique constraint
alter table public.customers
  drop constraint if exists customers_tenant_id_key;

alter table public.customers
  add constraint customers_tenant_id_key
  unique (tenant_id, id);


-- 3. Recreate the tenant-safe composite FK
alter table public.bookings
  add constraint bookings_customer_tenant_fkey
  foreign key (tenant_id, customer_id)
  references public.customers(tenant_id, id)
  on delete set null (customer_id);