'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { X, Loader2, Type, Image as ImageIcon, Images, Video, Clapperboard, LayoutGrid, UtensilsCrossed, Clock, MapPinned, CalendarDays } from 'lucide-react'
import { upsertWebsiteSection } from '@/lib/actions/website'
import { extractYoutubeVideoId, youtubeEmbedUrl } from '@/lib/website/youtube'
import { renderLightMarkdown } from '@/lib/website/markdown'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { ImageUploadField } from './ImageUploadField'
import type { WebsiteSectionType } from '@/lib/website/types'

export type SectionRow = {
  id: string
  type: WebsiteSectionType
  heading: string | null
  content: Record<string, unknown>
}

export const SECTION_TYPES: { type: WebsiteSectionType; label: string; description: string; icon: typeof Type }[] = [
  { type: 'text', label: 'Text', description: 'A heading and a paragraph.', icon: Type },
  { type: 'image', label: 'Image', description: 'A heading and one photo.', icon: ImageIcon },
  { type: 'image_text', label: 'Image + Text', description: 'A photo with text overlaid or stacked below.', icon: Images },
  { type: 'video', label: 'Video', description: 'A heading and a YouTube video.', icon: Video },
  { type: 'video_text', label: 'Video + Text', description: 'A YouTube video with a paragraph.', icon: Clapperboard },
  { type: 'resources', label: 'Featured Resources', description: 'Your bookable resources, pulled in live with a Book Now link.', icon: LayoutGrid },
  { type: 'menu', label: 'Menu Highlights', description: 'A few items from your food menu, pulled in live.', icon: UtensilsCrossed },
  { type: 'hours', label: 'Opening Hours', description: 'Your weekly hours, pulled from Working Hours.', icon: Clock },
  { type: 'map', label: 'Contact & Map', description: 'Your branch address on an embedded map.', icon: MapPinned },
  { type: 'events', label: 'Upcoming Events', description: 'Your next public events, pulled in live with a link to each.', icon: CalendarDays },
]

const DYNAMIC_LIMIT_LABEL: Partial<Record<WebsiteSectionType, string>> = {
  resources: 'Show up to how many resources?',
  menu: 'Show up to how many menu items?',
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const labelClass = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'

function str(content: Record<string, unknown>, key: string): string {
  const v = content[key]
  return typeof v === 'string' ? v : ''
}

function num(content: Record<string, unknown>, key: string, fallback: number): number {
  const v = content[key]
  return typeof v === 'number' ? v : fallback
}

type SectionModalProps =
  | { mode: 'add'; type: WebsiteSectionType; onClose: () => void }
  | { mode: 'edit'; section: SectionRow; onClose: () => void }

export function SectionModal(props: SectionModalProps) {
  const { onClose } = props
  const section = props.mode === 'edit' ? props.section : undefined
  const type = props.mode === 'edit' ? props.section.type : props.type

  const [heading, setHeading] = useState(section?.heading ?? '')
  const [body, setBody] = useState(section ? str(section.content, 'body') : '')
  const [imageUrl, setImageUrl] = useState(section ? str(section.content, 'imageUrl') : '')
  const [alt, setAlt] = useState(section ? str(section.content, 'alt') : '')
  const [caption, setCaption] = useState(section ? str(section.content, 'caption') : '')
  const [style, setStyle] = useState<'overlay' | 'stacked'>(
    section && str(section.content, 'style') === 'stacked' ? 'stacked' : 'overlay',
  )
  const [youtubeUrl, setYoutubeUrl] = useState(section ? str(section.content, 'youtubeUrl') : '')
  const [limit, setLimit] = useState(section ? num(section.content, 'limit', 6) : 6)
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useBodyScrollLock()

  const needsBody = type === 'text' || type === 'image_text' || type === 'video_text'
  const needsImage = type === 'image' || type === 'image_text'
  const needsVideo = type === 'video' || type === 'video_text'
  const needsLimit = type === 'resources' || type === 'menu' || type === 'events'
  const isLiveData = type === 'hours' || type === 'map'

  const errors = useMemo(() => {
    const e: { heading?: string; body?: string; imageUrl?: string; youtubeUrl?: string } = {}
    if (heading.trim().length > 200) e.heading = 'Heading must be at most 200 characters.'
    if (needsBody && !body.trim()) e.body = 'This section needs some text.'
    if (needsImage && !imageUrl) e.imageUrl = 'Upload an image.'
    if (needsVideo) {
      if (!youtubeUrl.trim()) e.youtubeUrl = 'Paste a YouTube link, e.g. https://youtu.be/…'
      else if (!extractYoutubeVideoId(youtubeUrl.trim()))
        e.youtubeUrl = 'Not a valid YouTube link — paste one like https://youtu.be/… or https://www.youtube.com/watch?v=…'
    }
    return e
  }, [heading, body, imageUrl, youtubeUrl, needsBody, needsImage, needsVideo])
  const isValid = Object.keys(errors).length === 0

  function buildContent(): Record<string, unknown> {
    switch (type) {
      case 'text':
        return { body }
      case 'image':
        return { imageUrl, alt: alt || undefined, caption: caption || undefined }
      case 'image_text':
        return { imageUrl, alt: alt || undefined, body, style }
      case 'video':
        return { youtubeUrl }
      case 'video_text':
        return { youtubeUrl, body }
      case 'resources':
      case 'menu':
      case 'events':
        return { limit }
      case 'hours':
      case 'map':
        return {}
    }
  }

  async function submit() {
    setSubmitted(true)
    if (!isValid) return
    setPending(true)
    const r = await upsertWebsiteSection({
      id: section?.id,
      type,
      heading: heading.trim() || null,
      content: buildContent(),
    })
    setPending(false)
    if (r.error) {
      toast.error(r.error)
    } else {
      toast.success(section ? 'Section updated.' : 'Section added.')
      onClose()
    }
  }

  const typeLabel = SECTION_TYPES.find((t) => t.type === type)?.label ?? type

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">{section ? `Edit ${typeLabel.toLowerCase()} section` : `Add ${typeLabel.toLowerCase()} section`}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className={labelClass}>Heading (optional)</label>
            <input
              className={`${inputClass} ${submitted && errors.heading ? inputInvalid : ''}`}
              placeholder="e.g. Why customers love us"
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
              maxLength={200}
              autoFocus
            />
            {submitted && errors.heading && <p className={errorText}>{errors.heading}</p>}
          </div>

          {needsImage && (
            <div>
              <ImageUploadField label="Image" value={imageUrl} onChange={setImageUrl} />
              {submitted && errors.imageUrl && <p className={errorText}>{errors.imageUrl}</p>}
              <div className="mt-2">
                <label className={labelClass}>Alt text (optional)</label>
                <input
                  className={inputClass}
                  placeholder="Describe the image for screen readers"
                  value={alt}
                  onChange={(e) => setAlt(e.target.value)}
                  maxLength={200}
                />
              </div>
              {type === 'image' && (
                <div className="mt-2">
                  <label className={labelClass}>Caption (optional)</label>
                  <input
                    className={inputClass}
                    placeholder="Text shown under the image"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    maxLength={200}
                  />
                </div>
              )}
            </div>
          )}

          {type === 'image_text' && (
            <div>
              <label className={labelClass}>Layout</label>
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    style === 'overlay' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                  onClick={() => setStyle('overlay')}
                >
                  Text on image
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    style === 'stacked' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                  onClick={() => setStyle('stacked')}
                >
                  Image, then text
                </button>
              </div>
            </div>
          )}

          {needsVideo && (
            <div>
              <label className={labelClass}>YouTube link</label>
              <input
                className={`${inputClass} ${submitted && errors.youtubeUrl ? inputInvalid : ''}`}
                placeholder="Paste a YouTube link, e.g. https://youtu.be/…"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
              {submitted && errors.youtubeUrl && <p className={errorText}>{errors.youtubeUrl}</p>}
              {(() => {
                const videoId = extractYoutubeVideoId(youtubeUrl.trim())
                if (!videoId) return null
                return (
                  <div className="mt-2 aspect-video w-full overflow-hidden rounded-lg border border-border">
                    <iframe
                      src={youtubeEmbedUrl(videoId)}
                      title="YouTube preview"
                      allow="accelerometer; encrypted-media; picture-in-picture"
                      className="h-full w-full"
                    />
                  </div>
                )
              })()}
            </div>
          )}

          {needsLimit && (
            <div>
              <label className={labelClass}>{DYNAMIC_LIMIT_LABEL[type]}</label>
              <input
                type="number"
                min={1}
                max={12}
                className={`${inputClass} w-24`}
                value={limit}
                onChange={(e) => setLimit(Math.min(12, Math.max(1, Number(e.target.value) || 1)))}
              />
            </div>
          )}

          {isLiveData && (
            <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              {type === 'hours'
                ? "This section always shows your branch's current Working Hours — nothing to configure here."
                : "This section always shows your branch's current address — nothing to configure here."}
            </p>
          )}

          {needsBody && (
            <div>
              <label className={labelClass}>Text</label>
              <textarea
                className={`${inputClass} ${submitted && errors.body ? inputInvalid : ''}`}
                rows={5}
                placeholder="Write a paragraph…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Light markdown supported: **bold**, *italic*, [link](https://example.com), and &ldquo;- &rdquo; bullet lists.
              </p>
              {submitted && errors.body && <p className={errorText}>{errors.body}</p>}
              {body.trim() && (
                <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary [&_ul]:list-disc [&_ul]:pl-5">
                  {renderLightMarkdown(body)}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            {pending ? 'Saving…' : section ? 'Save Changes' : 'Add Section'}
          </button>
        </div>
      </div>
    </div>
  )
}
