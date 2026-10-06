import { Reveal } from '../ui/Reveal'
import { SectionHeading } from '../ui/SectionHeading'

const STEPS = [
  {
    title: 'Create your workspace',
    description: 'Pick a plan and claim your own subdomain. Your venue is ready in a couple of minutes.',
  },
  {
    title: 'Set up your venue',
    description: 'Add resources, prices, working hours, your menu and your team. Connect your online payment account.',
  },
  {
    title: 'Start taking bookings',
    description: 'Share your booking link or QR code, and run walk-ins, food and billing from the same screen.',
  },
]

export function HowItWorks() {
  return (
    <section className="bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading eyebrow="How it works" title="From sign-up to first booking in three steps." />

        <ol className="relative mt-16 grid gap-10 md:grid-cols-3 md:gap-6">
          {/* connector line behind the numbered circles */}
          <div className="pointer-events-none absolute left-[16%] right-[16%] top-7 hidden h-px bg-gradient-to-r from-transparent via-border-strong to-transparent md:block" />
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative text-center">
              <Reveal delay={i * 130}>
                <span className="relative mx-auto flex size-14 items-center justify-center rounded-full bg-primary text-xl font-extrabold text-primary-foreground shadow-lg shadow-primary/30 ring-8 ring-background">
                  {i + 1}
                </span>
                <h3 className="mt-5 text-lg font-bold tracking-tight">{s.title}</h3>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{s.description}</p>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
