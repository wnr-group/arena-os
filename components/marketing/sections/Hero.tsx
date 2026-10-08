import { Check, Sparkles } from 'lucide-react'
import { Reveal } from '../ui/Reveal'
import { HeroMockup } from '../mockups/HeroMockup'

const TRUST = ['No double bookings', 'GST-ready invoices', 'Your own branded site']

export function Hero() {
  return (
    <section id="home" className="relative scroll-mt-16 overflow-hidden">
      {/* backdrop */}
      <div className="mk-grid-bg pointer-events-none absolute inset-0" />
      <div className="mk-blob pointer-events-none absolute -left-24 top-0 size-[26rem] rounded-full bg-primary/25 blur-3xl" />
      <div className="mk-blob pointer-events-none absolute -right-24 top-40 size-[24rem] rounded-full bg-[#d49a3a]/25 blur-3xl [animation-delay:-6s]" />

      <div className="relative mx-auto max-w-7xl px-4 pb-20 pt-14 sm:px-6 sm:pt-20 lg:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-background/80 px-4 py-1.5 text-xs font-semibold text-accent-foreground shadow-sm backdrop-blur sm:text-sm">
              <Sparkles size={14} className="text-primary" />
              Built for India · GST invoices · UPI payments
            </span>
          </Reveal>

          <Reveal delay={100}>
            <h1 className="mt-6 text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl lg:leading-[1.04]">
              Run your entire venue from <span className="mk-gradient-text">one platform.</span>
            </h1>
          </Reveal>

          <Reveal delay={200}>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
              Bookings, walk-ins, POS, kitchen, staff and revenue — made for gaming cafés, studios, VR centres and
              restaurants. Launch your own booking site in minutes.
            </p>
          </Reveal>

          <Reveal delay={300}>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="#features"
                className="inline-flex w-full items-center justify-center rounded-xl border border-border-strong bg-background/80 px-7 py-3.5 text-base font-semibold backdrop-blur transition hover:-translate-y-0.5 hover:border-primary/40 hover:bg-background sm:w-auto"
              >
                See how it works
              </a>
            </div>
          </Reveal>

          <Reveal delay={400}>
            <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {TRUST.map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5">
                  <span className="flex size-4 items-center justify-center rounded-full bg-mint-bg text-mint">
                    <Check size={11} strokeWidth={3} />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal delay={450} direction="scale">
          <HeroMockup />
        </Reveal>
      </div>
    </section>
  )
}
