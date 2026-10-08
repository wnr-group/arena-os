import { Gamepad2, Glasses, Mic2, Music4, Radio, UtensilsCrossed, type LucideIcon } from 'lucide-react'
import { Reveal } from '../ui/Reveal'

const INDUSTRIES: { icon: LucideIcon; label: string }[] = [
  { icon: Gamepad2, label: 'Gaming cafés' },
  { icon: Mic2, label: 'Recording studios' },
  { icon: Radio, label: 'Podcast studios' },
  { icon: Music4, label: 'Dance studios' },
  { icon: Glasses, label: 'VR centres' },
  { icon: UtensilsCrossed, label: 'Restaurants' },
]

function Chips() {
  return (
    <>
      {INDUSTRIES.map(({ icon: Icon, label }) => (
        <span
          key={label}
          className="inline-flex shrink-0 items-center gap-2.5 rounded-full border border-border-strong bg-card px-5 py-3 text-sm font-semibold shadow-sm"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon size={15} />
          </span>
          {label}
        </span>
      ))}
    </>
  )
}

/** A slow, pausable marquee of the industries Arena OS is built for. */
export function IndustriesStrip() {
  return (
    <section id="industries" className="scroll-mt-16 border-y border-border bg-muted py-12">
      <Reveal>
        <p className="mb-7 text-center text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          One platform · every kind of venue
        </p>
      </Reveal>
      <div
        className="mk-marquee overflow-hidden px-4 [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]"
      >
        <div className="mk-marquee-track">
          <Chips />
          <div className="mk-marquee-dup" aria-hidden>
            <Chips />
          </div>
        </div>
      </div>
    </section>
  )
}
