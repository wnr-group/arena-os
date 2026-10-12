'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * An <img> that walks a list of candidate sources and renders `placeholder`
 * when none is usable — an empty/null entry is skipped up front and a source
 * that fails to load (a deleted object, a bad URL) falls through to the next
 * one, so a card never shows a broken-image icon or an empty box.
 *
 * The cards are server-rendered, so a bad image can finish failing BEFORE React
 * hydrates and `onError` would never fire for it. The mount effect therefore
 * also checks an already-completed-but-empty image (complete && naturalWidth 0)
 * and treats it as failed.
 *
 * Plain <img>, same as the other public components: nothing here depends on
 * next.config.ts remotePatterns. (If this ever moves to next/image, a custom
 * S3/R2 host must be added to remotePatterns and the CSP img-src.)
 */
export function FallbackImage({
  srcs,
  alt,
  className,
  placeholder,
  eager = false,
}: {
  srcs: (string | null | undefined)[]
  alt: string
  className?: string
  placeholder: React.ReactNode
  eager?: boolean
}) {
  const candidates = srcs.filter((s): s is string => Boolean(s))
  const [failed, setFailed] = useState(0)
  const ref = useRef<HTMLImageElement>(null)
  const src = candidates[failed]

  useEffect(() => {
    const el = ref.current
    if (el && el.complete && el.naturalWidth === 0) setFailed((n) => n + 1)
  }, [src])

  if (!src) return <>{placeholder}</>
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      ref={ref}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      className={className}
      onError={() => setFailed((n) => n + 1)}
    />
  )
}
