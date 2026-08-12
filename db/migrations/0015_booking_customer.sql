-- Arena OS — 0007: link bookings to the customer directory

alter table public.bookings
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

-- Drives the profile's history query and both summary counts.
create index if not exists idx_bookings_customer
  on public.bookings(tenant_id, customer_id) where (customer_id is not null);

