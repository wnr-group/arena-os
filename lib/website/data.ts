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

/** Just published_at — page.tsx uses it to compute the unpublished-changes badge. */
export async function getWebsitePublishedAt(ctx: ActiveContext): Promise<Date | null> {
  const [row] = await withUser(ctx.user.id, (tx) =>
    tx.select({ publishedAt: websitePages.publishedAt }).from(websitePages).where(eq(websitePages.tenantId, ctx.tenant.id)).limit(1),
  )
  return row?.publishedAt ?? null
}
