import { Suspense } from 'react'
import { Users } from 'lucide-react'
import type { WebsiteSection } from '@/lib/website/types'
import type { PublicBranch } from '@/lib/booking/public-availability'
import { getPublicResourceTypes, getPublicWorkingHours } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublicActiveHappyHourRules } from '@/lib/happy-hours/public'
import { applyHappyHour } from '@/lib/happy-hours/apply'
import { extractYoutubeVideoId, youtubeEmbedUrl } from '@/lib/website/youtube'
import { renderLightMarkdown } from '@/lib/website/markdown'
import { MenuHighlightsClient } from '@/components/public-booking/MenuHighlightsClient'
import { ResourceTypeCard } from '@/components/public-booking/ResourceTypeCard'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** '14:30' -> '2:30 PM' — working_hours stores plain wall-clock strings, no timezone math needed to display them. */
function formatHour(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`
}

/** Renders a published (or previewed-draft) website's ordered sections. */
export function WebsiteSections({
  sections,
  tenantId,
  branch,
  currency,
  timezone,
}: {
  sections: WebsiteSection[]
  /** Needed by the dynamic sections (resources/menu/hours/map) to fetch their own live data. */
  tenantId: string
  branch: PublicBranch | null
  currency: string
  /** Needed by the 'menu' section to price items against live happy-hour rules. */
  timezone: string
}) {
  return (
    <main className="flex-1">
      {sections.map((section, i) => (
        <WebsiteSectionBlock
          key={section.id}
          section={section}
          tinted={i % 2 === 1}
          tenantId={tenantId}
          branch={branch}
          currency={currency}
          timezone={timezone}
        />
      ))}
    </main>
  )
}

async function WebsiteSectionBlock({
  section,
  tinted,
  tenantId,
  branch,
  currency,
  timezone,
}: {
  section: WebsiteSection
  tinted: boolean
  tenantId: string
  branch: PublicBranch | null
  currency: string
  timezone: string
}) {
  switch (section.type) {
    case 'text':
      return (
        <SectionShell heading={section.heading} tinted={tinted}>
          <div className="mx-auto max-w-2xl space-y-4 text-center text-base leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary">
            {renderLightMarkdown(section.content.body)}
          </div>
        </SectionShell>
      )
    case 'image':
      return (
        <SectionShell heading={section.heading} tinted={tinted}>
          <figure className="mx-auto max-w-4xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={section.content.imageUrl}
              alt={section.content.alt ?? ''}
              className="mx-auto max-h-[32rem] w-full rounded-2xl border border-border object-cover shadow-lg shadow-black/5"
            />
            {section.content.caption && (
              <figcaption className="mt-3 text-center text-sm text-muted-foreground">{section.content.caption}</figcaption>
            )}
          </figure>
        </SectionShell>
      )
    case 'image_text':
      return (
        <SectionShell heading={section.heading} tinted={tinted} wide={section.content.style === 'overlay'}>
          {section.content.style === 'overlay' ? (
            <div className="relative mx-auto max-w-4xl overflow-hidden rounded-2xl border border-border shadow-lg shadow-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={section.content.imageUrl} alt={section.content.alt ?? ''} className="h-[28rem] w-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-6 pt-16 sm:p-8 sm:pt-20">
                <div className="mx-auto max-w-2xl space-y-2 text-center text-base leading-relaxed text-white/90 [&_strong]:font-semibold [&_strong]:text-white [&_a]:text-white [&_a]:underline">
                  {renderLightMarkdown(section.content.body)}
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-6 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={section.content.imageUrl}
                alt={section.content.alt ?? ''}
                className="mx-auto max-h-[28rem] w-full rounded-2xl border border-border object-cover shadow-lg shadow-black/5"
              />
              <div className="space-y-4 text-base leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary">
                {renderLightMarkdown(section.content.body)}
              </div>
            </div>
          )}
        </SectionShell>
      )
    case 'video':
      return (
        <SectionShell heading={section.heading} tinted={tinted}>
          <YoutubeEmbed youtubeUrl={section.content.youtubeUrl} />
        </SectionShell>
      )
    case 'video_text':
      return (
        <SectionShell heading={section.heading} tinted={tinted}>
          <div className="mx-auto max-w-2xl space-y-6">
            <YoutubeEmbed youtubeUrl={section.content.youtubeUrl} />
            <div className="space-y-4 text-center text-base leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary">
              {renderLightMarkdown(section.content.body)}
            </div>
          </div>
        </SectionShell>
      )
    case 'resources': {
      const count = Math.min(section.content.limit, 4)
      return (
        <Suspense fallback={<ResourcesSkeleton heading={section.heading} tinted={tinted} count={count} />}>
          <ResourcesContent section={section} tinted={tinted} tenantId={tenantId} branch={branch} currency={currency} />
        </Suspense>
      )
    }
    case 'menu': {
      const count = Math.min(section.content.limit, 4)
      return (
        <Suspense fallback={<MenuSkeleton heading={section.heading} tinted={tinted} count={count} />}>
          <MenuContent section={section} tinted={tinted} tenantId={tenantId} currency={currency} timezone={timezone} />
        </Suspense>
      )
    }
    case 'hours': {
      if (!branch) return null
      const hours = await getPublicWorkingHours(tenantId, branch.id)
      return (
        <SectionShell heading={section.heading ?? 'Opening Hours'} tinted={tinted}>
          <div className="mx-auto max-w-md divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            {hours.map((h) => (
              <div key={h.dayOfWeek} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium">{DAY_NAMES[h.dayOfWeek]}</span>
                <span className="text-muted-foreground">
                  {h.isClosed ? 'Closed' : `${formatHour(h.openTime)} – ${formatHour(h.closeTime)}`}
                </span>
              </div>
            ))}
          </div>
        </SectionShell>
      )
    }
    case 'map': {
      if (!branch?.address) return null
      return (
        <SectionShell heading={section.heading ?? 'Find Us'} tinted={tinted} wide>
          <div className="mx-auto aspect-video w-full max-w-4xl overflow-hidden rounded-2xl border border-border shadow-lg shadow-black/5">
            <iframe
              src={`https://www.google.com/maps?q=${encodeURIComponent(branch.address)}&output=embed`}
              title="Map"
              loading="lazy"
              className="h-full w-full"
            />
          </div>
        </SectionShell>
      )
    }
  }
}

/** The 'resources' case's data fetch, split out so it can stream behind its
 *  own Suspense boundary (ResourcesSkeleton) instead of blocking the rest
 *  of the homepage while getPublicResourceTypes resolves. */
async function ResourcesContent({
  section,
  tinted,
  tenantId,
  branch,
  currency,
}: {
  section: Extract<WebsiteSection, { type: 'resources' }>
  tinted: boolean
  tenantId: string
  branch: PublicBranch | null
  currency: string
}) {
  if (!branch) return null
  const types = (await getPublicResourceTypes(tenantId, branch.id)).slice(0, section.content.limit)
  if (types.length === 0) return null
  return (
<<<<<<< HEAD
    <SectionShell heading={section.heading ?? 'What We Offer'} tinted={tinted} maxWidthClass="max-w-6xl">
=======
    <SectionShell heading={section.heading ?? 'What We Offer'} tinted={tinted} wide>
>>>>>>> fd19abd (feat: apply tenant branding across all public pages, stream homepage sections)
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {types.map((t) => (
          <ResourceTypeCard key={t.id} type={t} currency={currency} />
        ))}
      </div>
    </SectionShell>
  )
}

/** Same shell as the real content (so the heading — already known
 *  synchronously — appears immediately, only the card grid is a
 *  placeholder) in case count is capped to the grid's own widest layout. */
function ResourcesSkeleton({ heading, tinted, count }: { heading: string | null; tinted: boolean; count: number }) {
  return (
<<<<<<< HEAD
    <SectionShell heading={heading ?? 'What We Offer'} tinted={tinted} maxWidthClass="max-w-6xl">
=======
    <SectionShell heading={heading ?? 'What We Offer'} tinted={tinted} wide>
>>>>>>> fd19abd (feat: apply tenant branding across all public pages, stream homepage sections)
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: count }).map((_, i) => (
          <ResourceCardSkeleton key={i} />
        ))}
      </div>
    </SectionShell>
  )
}

function ResourceCardSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="skeleton-shimmer aspect-[4/3] w-full shrink-0" />
      <div className="flex flex-1 flex-col p-5">
        <div className="skeleton-shimmer h-5 w-3/4 rounded-md" />
        <div className="mt-2 min-h-10 space-y-2">
          <div className="skeleton-shimmer h-3.5 w-full rounded-md" />
          <div className="skeleton-shimmer h-3.5 w-[85%] rounded-md" />
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground/30">
            <Users size={12} />
            <span className="skeleton-shimmer h-3.5 w-12 rounded-md" />
          </span>
          <div className="skeleton-shimmer h-4 w-16 rounded-md" />
        </div>
      </div>
    </div>
  )
}

/** The 'menu' case's data fetch, split out for the same reason as
<<<<<<< HEAD
 *  ResourcesContent above. Cart-aware (MenuHighlightsClient) so a visitor can
 *  add straight from the homepage — the same OrderCartProvider that
 *  WebsitePage mounts around the whole section stack. */
=======
 *  ResourcesContent above. */
>>>>>>> fd19abd (feat: apply tenant branding across all public pages, stream homepage sections)
async function MenuContent({
  section,
  tinted,
  tenantId,
  currency,
<<<<<<< HEAD
  timezone,
=======
>>>>>>> fd19abd (feat: apply tenant branding across all public pages, stream homepage sections)
}: {
  section: Extract<WebsiteSection, { type: 'menu' }>
  tinted: boolean
  tenantId: string
  currency: string
<<<<<<< HEAD
  timezone: string
}) {
  const [menu, happyHourRules] = await Promise.all([getPublicMenu(tenantId), getPublicActiveHappyHourRules(tenantId)])
  const items = menu.flatMap((c) => c.items).slice(0, section.content.limit)
  if (items.length === 0) return null

  const now = new Date()
  const orderableItems = items.map((item) => {
    const applied = item.available ? applyHappyHour(Number(item.price), happyHourRules, now, timezone) : null
    return { ...item, discountedPrice: applied ? applied.unitPrice.toFixed(2) : null }
  })

  return (
    <SectionShell heading={section.heading ?? 'From the Menu'} tinted={tinted} maxWidthClass="max-w-6xl">
      <MenuHighlightsClient items={orderableItems} currency={currency} />
=======
}) {
  const items = (await getPublicMenu(tenantId)).flatMap((c) => c.items).slice(0, section.content.limit)
  if (items.length === 0) return null
  return (
    <SectionShell heading={section.heading ?? 'From the Menu'} tinted={tinted} wide>
      <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
        {items.map((item) => (
          <MenuItemCard key={item.id} item={item} currency={currency} />
        ))}
      </div>
>>>>>>> fd19abd (feat: apply tenant branding across all public pages, stream homepage sections)
      <p className="mt-8 text-center">
        <a href="/food-menu" className="text-sm font-medium text-primary hover:underline">
          View full menu &rarr;
        </a>
      </p>
    </SectionShell>
  )
}

function MenuSkeleton({ heading, tinted, count }: { heading: string | null; tinted: boolean; count: number }) {
  return (
<<<<<<< HEAD
    <SectionShell heading={heading ?? 'From the Menu'} tinted={tinted} maxWidthClass="max-w-6xl">
=======
    <SectionShell heading={heading ?? 'From the Menu'} tinted={tinted} wide>
>>>>>>> fd19abd (feat: apply tenant branding across all public pages, stream homepage sections)
      <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
        {Array.from({ length: count }).map((_, i) => (
          <MenuCardSkeleton key={i} />
        ))}
      </div>
    </SectionShell>
  )
}

function MenuCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="skeleton-shimmer aspect-square w-full sm:aspect-[16/11]" />
      <div className="flex flex-1 flex-col p-3 sm:p-5">
        <div className="skeleton-shimmer h-3.5 w-3/4 rounded-md sm:h-4" />
        <div className="mt-1.5 hidden flex-1 space-y-1.5 sm:block">
          <div className="skeleton-shimmer h-3.5 w-full rounded-md" />
          <div className="skeleton-shimmer h-3.5 w-[65%] rounded-md" />
        </div>
        <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2.5 sm:mt-4 sm:pt-4">
          <span className="hidden text-[10px] font-bold uppercase tracking-widest text-muted-foreground/30 sm:inline">
            Price
          </span>
          <div className="flex items-center gap-2">
            <div className="skeleton-shimmer h-4 w-10 rounded-md sm:h-5 sm:w-14" />
            <div className="skeleton-shimmer size-7 shrink-0 rounded-full sm:size-8" />
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionShell({
  heading,
  tinted,
  wide,
  maxWidthClass,
  children,
}: {
  heading: string | null
  tinted: boolean
  wide?: boolean
  /** Overrides the default wide/narrow max-width — the 'menu' section uses
   *  this to match /food-menu's grid container (max-w-6xl) exactly, so cards
   *  render at the same width/height there as everywhere else they appear. */
  maxWidthClass?: string
  children: React.ReactNode
}) {
  return (
    <section className={`scroll-mt-16 ${tinted ? 'bg-card/40' : ''}`}>
      <div className={`mx-auto px-4 py-14 sm:px-6 sm:py-16 ${maxWidthClass ?? (wide ? 'max-w-5xl' : 'max-w-3xl')}`}>
        {heading && (
          <h2 className="mb-6 text-center text-2xl font-extrabold tracking-tight sm:text-3xl">{heading}</h2>
        )}
        {children}
      </div>
    </section>
  )
}

function YoutubeEmbed({ youtubeUrl }: { youtubeUrl: string }) {
  const videoId = extractYoutubeVideoId(youtubeUrl)
  if (!videoId) return null // already validated at write time; defensive only
  return (
    <div className="mx-auto aspect-video w-full max-w-3xl overflow-hidden rounded-2xl border border-border shadow-lg shadow-black/5">
      <iframe
        src={youtubeEmbedUrl(videoId)}
        title="YouTube video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="h-full w-full"
      />
    </div>
  )
}
