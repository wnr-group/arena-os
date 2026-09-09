-- ============================================================================
-- Arena OS — 0087 an index for the PLATFORM-WIDE revenue reads (AROS-114)
--
-- Not a schema change. One index, for three queries in
-- lib/platform/billing/metrics.ts that scan `platform_invoices` by DATE with no
-- tenant in the predicate.
--
-- ── why the existing index does not serve them ──────────────────────────────
--
-- 0081 created idx_platform_invoices_tenant on (tenant_id, invoice_date desc,
-- created_at desc), which is exactly right for the read it was built for — a
-- business's own billing history, and the operator's drill-down into one
-- company. Both know the tenant.
--
-- The revenue dashboard does not. readRevenue() aggregates every paid invoice
-- in a window across the whole platform, and readBilledCurrencies() asks which
-- currencies appear in that window. With `tenant_id` as the leading column
-- neither can use the index, so both fall back to a sequential scan of the
-- table — twice per dashboard load, on the one table that grows with every
-- charge Arena OS ever collects.
--
-- ── the shape ───────────────────────────────────────────────────────────────
--
-- Leading on `invoice_date` because that is the range predicate. `currency` is
-- carried as the second column so the currency read is answered from the index
-- alone, and `kind`/`status` follow so the `kind = 'subscription' and status =
-- 'paid'` filter is applied there too rather than by re-reading heap rows.
--
-- Deliberately NOT partial on that filter: the same range scan also feeds the
-- credit-note series (`kind = 'credit_note'`), which a partial index would
-- exclude and send back to a sequential scan.
--
-- The refund side of the same dashboard already has its index —
-- idx_platform_refunds_processed on (processed_at) where status = 'processed',
-- added by 0085 for precisely this reason. This is its counterpart.
-- ============================================================================

create index if not exists idx_platform_invoices_date
  on public.platform_invoices (invoice_date, currency, kind, status);

comment on index public.idx_platform_invoices_date is
  'Platform-wide revenue reads (lib/platform/billing/metrics.ts), which filter by date and currency with NO tenant_id — so idx_platform_invoices_tenant, which leads on tenant_id, cannot serve them.';
