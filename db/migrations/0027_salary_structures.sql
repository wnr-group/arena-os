-- ============================================================================
-- Arena OS — 0027 salary_structures: base pay + allowances/deductions per
-- staff member, versioned by effective date (AROS-85 / M11, first ticket).
--
-- One membership can have many rows over time — a raise INSERTs a new row
-- with a later effective_from rather than rewriting the old one, so past pay
-- stays reconstructable once payroll runs (AROS-104) start reading this and
-- snapshotting payslips from it. Unique (membership_id, effective_from) means
-- correcting a mistake before it's ever been paid out is an UPDATE of that
-- exact row; recording a raise is an INSERT of a new one.
--
-- allowances/deductions are jsonb arrays of named line items ({label, amount})
-- rather than fixed columns — HRA/PF today, but the set of components varies
-- per tenant and shouldn't require a migration to add one. Same shape as
-- TaxBreakupLine on invoices (0018): amounts are numeric(10,2)-shaped strings,
-- never floats.
--
-- Compensation is the most sensitive per-person data in the system, more so
-- than the business's own legal identity (business_profiles, 0020) — so
-- unlike that table this is OWNER-only for read as well as write; managers
-- run the shop but do not see what colleagues are paid.
-- ============================================================================

create table if not exists public.salary_structures (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  membership_id  uuid not null references public.memberships(id) on delete cascade,
  base           numeric(10,2) not null default 0 check (base >= 0),
  allowances     jsonb not null default '[]',
  deductions     jsonb not null default '[]',
  effective_from date not null,
  created_by     uuid references public.memberships(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (membership_id, effective_from)
);
create index if not exists idx_salary_structures_member on public.salary_structures(membership_id, effective_from desc);

drop trigger if exists trg_salary_structures_updated on public.salary_structures;
create trigger trg_salary_structures_updated before update on public.salary_structures
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.salary_structures enable row level security;

drop policy if exists salary_structures_owner_rw on public.salary_structures;
create policy salary_structures_owner_rw on public.salary_structures
  for all using (public.auth_role_in(tenant_id) = 'owner')
          with check (public.auth_role_in(tenant_id) = 'owner');

grant select, insert, update, delete on public.salary_structures to arena_app;
