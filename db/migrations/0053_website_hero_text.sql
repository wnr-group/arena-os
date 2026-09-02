-- ============================================================================
-- Arena OS — 0053 website hero text: lets a manager/owner set a headline,
-- subheading, and an optional call-to-action button on the website builder's
-- hero image, alongside the existing hero_image_url. Same table, no RLS
-- changes needed (0044_website_sections.sql's website_settings policies
-- already cover every column on the row).
-- ============================================================================

alter table public.website_settings
  add column if not exists hero_heading text,
  add column if not exists hero_subheading text,
  add column if not exists hero_cta_text text,
  add column if not exists hero_cta_url text;
