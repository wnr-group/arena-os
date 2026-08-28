-- ============================================================================
-- Arena OS — 0063: `restaurant` as a tenant industry
--
-- M17 (dine-in table service) is opt-in: a restaurant tenant gets floor/table
-- ergonomics on top of the SAME booking/orders/KOT/billing engine every other
-- industry already uses (see 0003's own header comment) — nothing here forks
-- that engine, it only widens the label a tenant may pick.
--
-- Split into its own migration because a value just added by
-- ALTER TYPE ... ADD VALUE cannot be referenced within the same transaction
-- that added it (a hard Postgres restriction), and scripts/migrate.ts runs
-- each file in one transaction — exactly the reason 0051/0052 were split.
-- Anything that needs to reference 'restaurant' (checks, backfills) belongs in
-- a later migration file.
-- ============================================================================

alter type public.tenant_industry add value if not exists 'restaurant' before 'other';
