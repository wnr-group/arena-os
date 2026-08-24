-- Arena OS — 0012 business profiles: the tenant's legal identity for GST
-- invoices (legal name, GSTIN, address, logo, invoice prefix, place of supply).

create table if not exists public.business_profiles (
  -- tenant_id IS the primary key: exactly one profile per tenant, no surrogate
  -- id, no second row possible.
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  legal_name      text,
  gstin           text,
  address         text,
  logo_url        text,
  invoice_prefix  text not null default 'INV',
  place_of_supply text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A GST invoice number may not exceed 16 characters, and the numbering format
  -- in lib/billing/invoice.ts is `PREFIX/YYYY/NNNNNN` — 12 characters plus the
  -- prefix. So a prefix longer than 4 would mint non-compliant numbers, and a
  -- blank one would mint '/2627/000001'. Enforced here as well as in Zod so the
  -- constraint cannot be bypassed by any future writer.
  constraint business_profiles_prefix_shape
    check (btrim(invoice_prefix) <> '' and length(invoice_prefix) <= 4)
);

drop trigger if exists trg_business_profiles_updated on public.business_profiles;
create trigger trg_business_profiles_updated before update on public.business_profiles
  for each row execute function public.set_updated_at();

-- RLS + grants. The letterhead is READ by anything that renders an invoice, so
-- every member of the tenant may select it; only the OWNER may change the
-- business's legal identity — not managers, who can otherwise run the shop.
alter table public.business_profiles enable row level security;

drop policy if exists business_select on public.business_profiles;
create policy business_select on public.business_profiles
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists business_write on public.business_profiles;
create policy business_write on public.business_profiles
  for all using (public.auth_role_in(tenant_id) = 'owner')
          with check (public.auth_role_in(tenant_id) = 'owner');

grant select, insert, update, delete on public.business_profiles to arena_app;
