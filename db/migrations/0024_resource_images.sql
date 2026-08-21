-- ============================================================================
-- Arena OS — 0024 resource images: photo for resource types + per-unit override
--
-- resource_types already has `description` (0003); adding image_url alongside it.
-- resources gets both image_url and description so a unit can override either
-- of its type's defaults (falls back to the type's value when null).
-- ============================================================================

alter table public.resource_types
  add column if not exists image_url text;

alter table public.resources
  add column if not exists image_url text,
  add column if not exists description text;
