-- ============================================================================
-- Arena OS — 0011 menu_items: description + manual sort order
-- ============================================================================

alter table public.menu_items
  add column if not exists description text,
  add column if not exists sort_order integer not null default 0;
