'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Home, RotateCcw, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

const SLOTS = ['10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM']
const CONFETTI_COLORS = ['#8b2242', '#c0396b', '#d49a3a', '#e3b565', '#2f8055']

/** The "0" of the 404: a ring whose gold pupil follows the cursor (or a finger dragging across the screen). */
function WatchingZero() {
  const ring = useRef<HTMLDivElement>(null)
  const pupil = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function look(e: PointerEvent) {
      const r = ring.current
      const p = pupil.current
      if (!r || !p) return
      const box = r.getBoundingClientRect()
      const dx = e.clientX - (box.left + box.width / 2)
      const dy = e.clientY - (box.top + box.height / 2)
      const dist = Math.hypot(dx, dy)
      // How far the pupil may travel: the ring's inner radius minus the pupil's own radius.
      const max = (box.width - 2 * r.clientLeft) / 2 - p.offsetWidth / 2 - 4
      const k = dist === 0 ? 0 : Math.min(dist, max) / dist
      p.style.transform = `translate(${dx * k}px, ${dy * k}px)`
    }
    window.addEventListener('pointermove', look)
    window.addEventListener('pointerdown', look)
    return () => {
      window.removeEventListener('pointermove', look)
      window.removeEventListener('pointerdown', look)
    }
  }, [])

  return (
    <div
      ref={ring}
      aria-hidden
      className="relative flex size-20 shrink-0 items-center justify-center rounded-full border-[12px] border-primary bg-background shadow-xl shadow-primary/25 sm:size-32 sm:border-[18px]"
    >
      <div
        ref={pupil}
        className="size-7 rounded-full bg-gradient-to-br from-[#e3b565] to-[#d49a3a] shadow-md transition-transform duration-100 ease-out sm:size-11"
      />
    </div>
  )
}

/** "Find the one free slot": every tile looks the same until tapped, and exactly one of them is open. */
function SlotGame() {
  // Chosen after mount so the server render and first client render agree (no Math.random during hydration).
  const [free, setFree] = useState<number | null>(null)
  const [tried, setTried] = useState<number[]>([])
  const found = free !== null && tried.includes(free)

  useEffect(() => {
    setFree(Math.floor(Math.random() * SLOTS.length))
  }, [])

  function pick(i: number) {
    if (free === null || found || tried.includes(i)) return
    setTried((t) => [...t, i])
  }

  function reset() {
    setTried([])
    setFree(Math.floor(Math.random() * SLOTS.length))
  }

  return (
    <div className="mx-auto w-full max-w-md rounded-3xl border border-border-strong bg-card/90 p-5 shadow-xl shadow-primary/10 backdrop-blur sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="text-left">
          <p className="text-sm font-bold tracking-tight">Find the one free slot</p>
          <p className="text-xs text-muted-foreground">Everything else is booked. Tap a time to check.</p>
        </div>
        <span className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-bold tabular-nums text-accent-foreground">
          Tries: {tried.length}
        </span>
      </div>

      <div className="relative mt-4 grid grid-cols-4 gap-2">
        {SLOTS.map((label, i) => {
          const isTried = tried.includes(i)
          const isFree = isTried && i === free
          return (
            <button
              key={label}
              type="button"
              onClick={() => pick(i)}
              disabled={isTried || found}
              aria-label={isTried ? `${label}: ${isFree ? 'free' : 'booked'}` : `Check ${label}`}
              className={cn(
                'rounded-xl border px-1 py-3 text-xs font-semibold transition duration-200 sm:text-sm',
                !isTried && !found && 'border-border-strong bg-background hover:-translate-y-0.5 hover:border-primary hover:bg-accent hover:shadow-md',
                !isTried && found && 'border-border bg-muted text-subtle-foreground',
                isTried && !isFree && 'mk-shake border-rose-border bg-rose-bg text-rose',
                isFree && 'border-mint bg-mint-bg text-mint shadow-lg shadow-mint/25',
              )}
            >
              {isTried ? (isFree ? 'Free!' : 'Booked') : label}
            </button>
          )
        })}

        {found && (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {Array.from({ length: 18 }, (_, n) => (
              <span
                key={n}
                className="mk-confetti absolute size-2 rounded-sm"
                style={
                  {
                    '--a': `${n * 20}deg`,
                    backgroundColor: CONFETTI_COLORS[n % CONFETTI_COLORS.length],
                    animationDelay: `${(n % 3) * 60}ms`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        )}
      </div>

      <div aria-live="polite" className="mt-4 min-h-10 text-sm">
        {found ? (
          <p className="flex items-start gap-2 font-medium text-mint">
            <Sparkles size={16} className="mt-0.5 shrink-0" />
            {tried.length === 1
              ? 'First try! Unlike this page, that slot actually exists.'
              : `Found it in ${tried.length} tries. Unlike this page, that slot actually exists.`}
          </p>
        ) : (
          <p className="text-muted-foreground">{tried.length === 0 ? 'No luck yet — pick a time.' : 'Booked. Keep looking…'}</p>
        )}
      </div>

      {tried.length > 0 && (
        <button
          type="button"
          onClick={reset}
          className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <RotateCcw size={13} /> Play again
        </button>
      )}
    </div>
  )
}

export function NotFoundExperience() {
  const router = useRouter()

  return (
    <div className="relative mx-auto flex w-full max-w-2xl flex-col items-center text-center">
      <div className="flex items-center justify-center gap-2 sm:gap-4" role="img" aria-label="Error 404">
        <span aria-hidden className="mk-gradient-text text-[6.5rem] font-black leading-none tracking-tighter sm:text-[10rem]">
          4
        </span>
        <WatchingZero />
        <span aria-hidden className="mk-gradient-text text-[6.5rem] font-black leading-none tracking-tighter sm:text-[10rem]">
          4
        </span>
      </div>

      <h1 className="mt-8 text-3xl font-extrabold tracking-tight sm:text-4xl">Page not found</h1>
      <p className="mt-3 max-w-md text-base leading-relaxed text-muted-foreground sm:text-lg">
        This page is either fully booked or never existed. Check the address, or head back and we&apos;ll get you sorted.
      </p>

      <div className="mt-7 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
        <Link
          href="/"
          className="mk-shine inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-7 py-3 text-base font-bold text-primary-foreground shadow-lg shadow-primary/25 transition hover:-translate-y-0.5 hover:bg-primary-hover sm:w-auto"
        >
          <Home size={17} />
          Go to homepage
        </Link>
        <button
          type="button"
          onClick={() => router.back()}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border-strong bg-background/80 px-7 py-3 text-base font-semibold backdrop-blur transition hover:-translate-y-0.5 hover:border-primary/40 sm:w-auto"
        >
          <ArrowLeft size={17} />
          Go back
        </button>
      </div>

      <div className="mt-10 w-full">
        <SlotGame />
      </div>
    </div>
  )
}
