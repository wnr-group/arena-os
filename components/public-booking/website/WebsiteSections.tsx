import type { WebsiteSection } from '@/lib/website/types'
import { extractYoutubeVideoId, youtubeEmbedUrl } from '@/lib/website/youtube'
import { renderLightMarkdown } from '@/lib/website/markdown'

/** Renders a published (or previewed-draft) website's ordered sections. */
export function WebsiteSections({ sections }: { sections: WebsiteSection[] }) {
  return (
    <main className="flex-1">
      {sections.map((section, i) => (
        <WebsiteSectionBlock key={section.id} section={section} tinted={i % 2 === 1} />
      ))}
    </main>
  )
}

function WebsiteSectionBlock({ section, tinted }: { section: WebsiteSection; tinted: boolean }) {
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
    <section className={`scroll-mt-16 border-b border-border ${tinted ? 'bg-card/40' : ''}`}>
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
