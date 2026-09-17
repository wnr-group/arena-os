-- ============================================================================
-- Arena OS — 0089: bill groups on invoices (M18 #2)
--
-- Splitting a table's bill means one booking now yields SEVERAL invoices —
-- one per "check" — instead of the usual one. `invoices.booking_id` already
-- carries no unique constraint (only `(tenant_id, invoice_number)` and
-- `(tenant_id, id)` are unique), so the schema already allows multiple
-- invoice rows per booking; the only thing that ever stopped it was
-- lib/billing/invoice.ts's application-level "one live invoice per booking"
-- rule (findLiveInvoice). That rule is being GENERALISED, not removed: a
-- booking may still only ever have one live billing episode — it is either
-- one plain invoice (bill_group_id null, exactly today's behaviour) or N
-- invoices sharing one bill_group_id (a split).
--
-- `bill_group_seq` is a stable 1-based position within the group purely for
-- display ("Check 2 of 3") — invoice numbering itself is unaffected: every
-- check still draws its own normal sequential GST invoice number from the
-- same `sequences` counter as any other invoice (see nextInvoiceNumber).
--
-- The two columns travel together: a check has both, a normal invoice has
-- neither. The CHECK constraint makes the DB enforce that pairing rather
-- than trusting application code to never write one without the other.
-- ============================================================================

alter table public.invoices
  add column if not exists bill_group_id  uuid,
  add column if not exists bill_group_seq smallint check (bill_group_seq is null or bill_group_seq > 0);

alter table public.invoices
  drop constraint if exists invoices_bill_group_pairing;
alter table public.invoices
  add constraint invoices_bill_group_pairing
    check ((bill_group_id is null) = (bill_group_seq is null));

comment on column public.invoices.bill_group_id is
  'Clusters the N invoices produced by one bill split (M18 #2) — null for every normal, unsplit
   invoice. All invoices sharing a bill_group_id together cover a booking''s billable lines
   exactly once each, and are billed/settled independently via the existing payments flow.';
comment on column public.invoices.bill_group_seq is
  '1-based position within bill_group_id, for stable "Check 2 of 3" display ordering only —
   invoice_number is still assigned normally and independently for each check.';

create index if not exists idx_invoices_bill_group
  on public.invoices(tenant_id, bill_group_id)
  where bill_group_id is not null;
