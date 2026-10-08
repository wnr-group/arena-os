import { Database, Rocket, ShieldCheck, type LucideIcon } from 'lucide-react'
import { Reveal } from '../ui/Reveal'
import { CountUp } from '../ui/CountUp'
import { SectionHeading } from '../ui/SectionHeading'

const PILLARS: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: ShieldCheck,
    title: 'Your data stays yours',
    description: 'Every business is isolated at the database level, so one venue can never see another’s data.',
  },
  {
    icon: Database,
    title: 'Double-booking proof',
    description: 'Overlaps are rejected by the database itself, not just the screen — online, at the desk or on a walk-in.',
  },
  {
    icon: Rocket,
    title: 'Live in minutes',
    description: 'Sign up, add your resources and hours, and share your booking link the same day.',
  },
]

const STATS: { to: number; suffix?: string; label: string }[] = [
  { to: 6, label: 'Industry setups' },
  { to: 6, label: 'Staff roles & permissions' },
  { to: 0, label: 'Double bookings, by design' },
  { to: 24, suffix: '/7', label: 'Online booking' },
]

/** The page's one dark section — a change of pace before pricing. */
export function WhyBand() {
  return (
    <section className="mk-dark relative overflow-hidden py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          invert
          eyebrow="Why Arena OS"
          title="Built on a foundation you can trust."
          subtitle="Serious infrastructure behind a simple interface."
        />

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {PILLARS.map(({ icon: Icon, title, description }, i) => (
            <Reveal key={title} delay={i * 100}>
              <div className="h-full rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur transition duration-300 hover:-translate-y-1 hover:bg-white/10">
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-white/10 text-[color:var(--mk-gold)]">
                  <Icon size={20} />
                </span>
                <h3 className="mt-5 text-lg font-bold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/70">{description}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <div className="mt-16 grid grid-cols-2 gap-y-10 border-t border-white/10 pt-12 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 100} className="text-center">
              <p className="text-5xl font-extrabold tracking-tight sm:text-6xl">
                <span className="bg-gradient-to-b from-white to-[color:var(--mk-gold)] bg-clip-text text-transparent">
                  <CountUp to={s.to} suffix={s.suffix} />
                </span>
              </p>
              <p className="mt-2 text-sm text-white/60">{s.label}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
