-- ============================================================================
-- Arena OS — 0052 website dynamic sections: fast-follow section types that
-- render live tenant data instead of free-text/media content — featured
-- resources, menu highlights, opening hours, and a contact map. No new
-- tables: these reuse website_sections.content (jsonb) and the existing
-- public data readers (lib/booking/public-availability.ts, lib/menu/public.ts).
-- ============================================================================

alter type public.website_section_type add value if not exists 'resources';
alter type public.website_section_type add value if not exists 'menu';
alter type public.website_section_type add value if not exists 'hours';
alter type public.website_section_type add value if not exists 'map';
