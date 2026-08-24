'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { X, Loader2, Type, Image as ImageIcon, Images, Video, Clapperboard } from 'lucide-react'
import { upsertWebsiteSection } from '@/lib/actions/website'
import { extractYoutubeVideoId } from '@/lib/website/youtube'
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
]

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
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useBodyScrollLock()

  const needsBody = type === 'text' || type === 'image_text' || type === 'video_text'
  const needsImage = type === 'image' || type === 'image_text'
  const needsVideo = type === 'video' || type === 'video_text'

  const errors = useMemo(() => {
    const e: { heading?: string; body?: string; imageUrl?: string; youtubeUrl?: string } = {}
    if (heading.trim().length > 200) e.heading = 'Heading must be at most 200 characters.'
    if (needsBody && !body.trim()) e.body = 'This section needs some text.'
    if (needsImage && !imageUrl) e.imageUrl = 'Upload an image.'
    if (needsVideo) {
      if (!youtubeUrl.trim()) e.youtubeUrl = 'Paste a YouTube link.'
      else if (!extractYoutubeVideoId(youtubeUrl.trim())) e.youtubeUrl = 'Must be a youtube.com or youtu.be video link.'
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
                placeholder="https://www.youtube.com/watch?v=…"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
              {submitted && errors.youtubeUrl && <p className={errorText}>{errors.youtubeUrl}</p>}
            </div>
          )}

          {needsBody && (
            <div>
              <label className={labelClass}>Text</label>
              <textarea
                className={`${inputClass} ${submitted && errors.body ? inputInvalid : ''}`}
                rows={5}
                placeholder="Write a paragraph. **bold**, *italic* and [links](https://example.com) are supported."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
              />
              {submitted && errors.body && <p className={errorText}>{errors.body}</p>}
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
