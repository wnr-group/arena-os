import type { WebsiteSection } from '@/lib/website/types'
import type { PublicBranch } from '@/lib/booking/public-availability'
import { getPublicResourceTypes, getPublicWorkingHours } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { extractYoutubeVideoId, youtubeEmbedUrl } from '@/lib/website/youtube'
import { renderLightMarkdown } from '@/lib/website/markdown'
import { MenuItemCard } from '@/components/public-booking/MenuItemCard'
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
}: {
  sections: WebsiteSection[]
  /** Needed by the dynamic sections (resources/menu/hours/map) to fetch their own live data. */
  tenantId: string
  branch: PublicBranch | null
  currency: string
}) {
  return (
    <main className="flex-1">
      {sections.map((section, i) => (
        <WebsiteSectionBlock key={section.id} section={section} tinted={i % 2 === 1} tenantId={tenantId} branch={branch} currency={currency} />
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
}: {
  section: WebsiteSection
  tinted: boolean
  tenantId: string
  branch: PublicBranch | null
  currency: string
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
      if (!branch) return null
      const types = (await getPublicResourceTypes(tenantId, branch.id)).slice(0, section.content.limit)
      if (types.length === 0) return null
      return (
        <SectionShell heading={section.heading ?? 'What We Offer'} tinted={tinted} wide>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {types.map((t) => (
              <ResourceTypeCard key={t.id} type={t} currency={currency} />
            ))}
          </div>
        </SectionShell>
      )
    }
    case 'menu': {
      const items = (await getPublicMenu(tenantId)).flatMap((c) => c.items).slice(0, section.content.limit)
      if (items.length === 0) return null
      return (
        <SectionShell heading={section.heading ?? 'From the Menu'} tinted={tinted} wide>
          <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
            {items.map((item) => (
              <MenuItemCard key={item.id} item={item} currency={currency} />
            ))}
          </div>
          <p className="mt-8 text-center">
            <a href="/food-menu" className="text-sm font-medium text-primary hover:underline">
              View full menu &rarr;
            </a>
          </p>
        </SectionShell>
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

function SectionShell({
  heading,
  tinted,
  wide,
  children,
}: {
  heading: string | null
  tinted: boolean
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <section className={`scroll-mt-16 ${tinted ? 'bg-card/40' : ''}`}>
      <div className={`mx-auto px-4 py-14 sm:px-6 sm:py-16 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
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
