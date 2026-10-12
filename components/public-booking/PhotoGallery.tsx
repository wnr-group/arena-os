'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'

/** "{name} — photo 2 of 3" — descriptive alt, shared by the slide, thumbnail and lightbox. */
export function photoAlt(name: string, index: number, total: number): string {
  return `${name} — photo ${index + 1} of ${total}`
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A small dependency-free photo gallery for 1–3 images.
 *
 *  - the main view is a horizontal scroll-snap strip: native swipe on touch,
 *    wheel/trackpad and the arrow buttons on desktop
 *  - thumbnails (only when there is more than one photo) jump to a slide
 *  - tapping a slide opens a lightbox: arrow keys / swipe to navigate, Esc to
 *    close, focus trapped inside and restored to the opener on close
 *
 * Every slide has a fixed 4:3 box, so nothing shifts when images load. The
 * first image is eager, the rest lazy. Remount it (key) when the photo set
 * changes, e.g. per selected setup.
 */
export function PhotoGallery({ images, name }: { images: string[]; name: string }) {
  const total = images.length
  const [active, setActive] = useState(0)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  const goTo = useCallback((i: number) => {
    const el = strip.current
    if (!el) return
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' })
    setActive(i)
  }, [])

  if (total === 0) return null

  const openLightbox = (i: number, e: React.MouseEvent<HTMLElement>) => {
    opener.current = e.currentTarget
    setLightbox(i)
  }
  const closeLightbox = () => {
    setLightbox(null)
    opener.current?.focus()
  }

  return (
    <section aria-label={`${name} photos`} className="select-none">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-muted">
        <div
          ref={strip}
          className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={(e) => {
            const el = e.currentTarget
            const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
            if (i !== active) setActive(Math.min(total - 1, Math.max(0, i)))
          }}
        >
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              onClick={(e) => openLightbox(i, e)}
              aria-label={`Enlarge ${photoAlt(name, i, total)}`}
              className="aspect-[4/3] w-full shrink-0 snap-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={photoAlt(name, i, total)}
                loading={i === 0 ? 'eager' : 'lazy'}
                draggable={false}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>

        {total > 1 && (
          <>
            <button
              type="button"
              onClick={() => goTo(Math.max(0, active - 1))}
              disabled={active === 0}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 shadow ring-1 ring-border transition hover:bg-background disabled:opacity-0 md:flex"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => goTo(Math.min(total - 1, active + 1))}
              disabled={active === total - 1}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 shadow ring-1 ring-border transition hover:bg-background disabled:opacity-0 md:flex"
            >
              <ChevronRight size={18} />
            </button>
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5 md:hidden" aria-hidden>
              {images.map((_, i) => (
                <span key={i} className={`size-1.5 rounded-full ${i === active ? 'bg-white' : 'bg-white/50'} shadow`} />
              ))}
            </div>
          </>
        )}
      </div>

      {total > 1 && (
        <ul className="mt-2 grid grid-cols-3 gap-2">
          {images.map((src, i) => (
            <li key={src}>
              <button
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Show photo ${i + 1} of ${total}`}
                aria-current={i === active}
                className={`block aspect-[4/3] w-full overflow-hidden rounded-lg border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  i === active ? 'border-primary' : 'border-transparent opacity-80 hover:opacity-100'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {lightbox !== null && (
        <Lightbox images={images} name={name} start={lightbox} onClose={closeLightbox} />
      )}
    </section>
  )
}

function Lightbox({
  images,
  name,
  start,
  onClose,
}: {
  images: string[]
  name: string
  start: number
  onClose: () => void
}) {
  const total = images.length
  const [index, setIndex] = useState(start)
  const dialog = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const touchX = useRef<number | null>(null)
  useBodyScrollLock()

  const step = useCallback((d: -1 | 1) => setIndex((i) => Math.min(total - 1, Math.max(0, i + d))), [total])

  useEffect(() => {
    closeBtn.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowLeft') {
        step(-1)
      } else if (e.key === 'ArrowRight') {
        step(1)
      } else if (e.key === 'Tab') {
        // Focus trap: keep Tab / Shift+Tab inside the dialog.
        const nodes = dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
        if (!nodes || nodes.length === 0) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        } else if (!dialog.current?.contains(document.activeElement)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, step])

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} photos`}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      onTouchStart={(e) => {
        touchX.current = e.touches[0]?.clientX ?? null
      }}
      onTouchEnd={(e) => {
        const from = touchX.current
        touchX.current = null
        const to = e.changedTouches[0]?.clientX
        if (from === null || to === undefined || Math.abs(to - from) < 40) return
        step(to < from ? 1 : -1)
      }}
    >
      <button
        ref={closeBtn}
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 flex size-10 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <X size={20} />
      </button>
      {total > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              step(-1)
            }}
            disabled={index === 0}
            aria-label="Previous photo"
            className="absolute left-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              step(1)
            }}
            disabled={index === total - 1}
            aria-label="Next photo"
            className="absolute right-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={images[index]}
        alt={photoAlt(name, index, total)}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-full rounded-lg object-contain"
      />
      <p className="pointer-events-none absolute bottom-4 left-0 right-0 text-center text-sm text-white/80" aria-live="polite">
        {index + 1} / {total}
      </p>
    </div>
  )
}
