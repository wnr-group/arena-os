'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

type Direction = 'up' | 'left' | 'right' | 'scale'

/**
 * Fades/slides its children in the first time they scroll into view. The CSS
 * lives in app/globals.css (`.mk-reveal`) and only hides content under
 * prefers-reduced-motion: no-preference, so reduced-motion users (and browsers
 * without IntersectionObserver) simply see everything immediately.
 */
export function Reveal({
  children,
  delay = 0,
  direction = 'up',
  className,
}: {
  children: ReactNode
  /** Stagger offset in ms. */
  delay?: number
  direction?: Direction
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true)
          io.disconnect()
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      data-dir={direction}
      style={{ '--mk-delay': `${delay}ms` } as React.CSSProperties}
      className={cn('mk-reveal', shown && 'is-in', className)}
    >
      {children}
    </div>
  )
}
