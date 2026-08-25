import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { websiteSections, websiteSettings, websitePages } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export function listWebsiteSections(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(websiteSections)
      .where(eq(websiteSections.tenantId, ctx.tenant.id))
      .orderBy(asc(websiteSections.position)),
  )
}

export async function getWebsiteSettings(ctx: ActiveContext) {
  const [row] = await withUser(ctx.user.id, (tx) =>
    tx.select().from(websiteSettings).where(eq(websiteSettings.tenantId, ctx.tenant.id)).limit(1),
  )
  return row ?? null
}

/** page.tsx diffs this snapshot against the live draft to compute the
 *  unpublished-changes badge (lib/website/status.ts) — publishedAt alone
 *  can't tell a real edit from a delete, since a deleted row leaves no
 *  updated_at behind to compare against. */
export async function getWebsitePublishedSnapshot(
  ctx: ActiveContext,
): Promise<{ publishedSnapshot: unknown; publishedAt: Date | null }> {
  const [row] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ publishedSnapshot: websitePages.publishedSnapshot, publishedAt: websitePages.publishedAt })
      .from(websitePages)
      .where(eq(websitePages.tenantId, ctx.tenant.id))
      .limit(1),
  )
  return { publishedSnapshot: row?.publishedSnapshot ?? null, publishedAt: row?.publishedAt ?? null }
}
