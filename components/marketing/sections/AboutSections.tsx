import Link from 'next/link'
import {
  BarChart3,
  CalendarCheck,
  Check,
  ChefHat,
  Eye,
  Gauge,
  Lock,
  Receipt,
  ShieldCheck,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Reveal } from '../ui/Reveal'
import { SectionHeading } from '../ui/SectionHeading'

const FLOW: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: CalendarCheck, title: 'Booked', text: 'A customer reserves online, or walks in and the timer starts.' },
  { icon: ChefHat, title: 'Served', text: 'Food orders reach the kitchen the moment they are placed.' },
  { icon: Receipt, title: 'Billed', text: 'One GST invoice covers time, food, discounts and advances.' },
  { icon: BarChart3, title: 'Understood', text: 'Revenue, expenses and payroll roll into a single P&L.' },
]

/** Story: three paragraphs on the left, the booking → books flow on the right. */
export function StorySection() {
  return (
    <section className="bg-background py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-2 lg:gap-20">
        <div>
          <Reveal>
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Our story</span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl lg:text-5xl lg:leading-[1.1]">
              One system for everything a venue does in a day.
            </h2>
          </Reveal>
          <div className="mt-6 space-y-5 text-base leading-relaxed text-muted-foreground sm:text-lg">
            <Reveal delay={80}>
              <p>
                Gaming cafés, studios, VR centres and restaurants all run on the same thing: a limited number of
                spaces, sold by the hour, with food and people moving around them. Yet most of them stitch together a
                booking app, a billing tool, a kitchen printer and a spreadsheet.
              </p>
            </Reveal>
            <Reveal delay={160}>
              <p>
                Arena OS puts it in one place. A booking, a walk-in, a plate of food and a GST invoice are parts of the
                same customer visit, so they live in the same system and always agree with each other.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <p>
                It is built for how Indian venues actually work: UPI and cash side by side, GST invoices, happy hours,
                weekend and holiday rates, advances and split bills.
              </p>
            </Reveal>
          </div>
        </div>

        <Reveal direction="right" delay={120}>
          <div className="relative rounded-[2rem] bg-gradient-to-br from-accent via-rose-bg/60 to-accent p-6 sm:p-10">
            <div className="mk-blob pointer-events-none absolute -right-6 -top-6 size-40 rounded-full bg-primary/15 blur-2xl" />
            <ol className="relative space-y-3">
              {FLOW.map(({ icon: Icon, title, text }, i) => (
                <li key={title} className="relative">
                  {i < FLOW.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute left-[1.65rem] top-14 h-[calc(100%-2.25rem)] w-px bg-gradient-to-b from-primary/40 to-primary/0"
                    />
                  )}
                  <div className="flex items-start gap-4 rounded-2xl border border-border-strong bg-card p-4 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/10">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25">
                      <Icon size={20} />
                    </span>
                    <div>
                      <p className="font-bold tracking-tight">{title}</p>
                      <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

const MISSION_POINTS = [
  'Make booking effortless for customers, on any phone.',
  'Keep the floor fast and free of billing mistakes.',
  'Give owners clear numbers they can trust.',
]

/** Vision (dark) and Mission (light) side by side, each with a large faded icon as a watermark. */
export function VisionMissionSection() {
  return (
    <section className="bg-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Vision & mission"
          title={
            <>
              Where we&apos;re headed, and <span className="mk-gradient-text">how we get there.</span>
            </>
          }
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <Reveal direction="left" className="h-full">
            <div className="mk-dark group relative h-full overflow-hidden rounded-[2rem] p-8 shadow-2xl shadow-primary/25 sm:p-12">
              <Eye
                aria-hidden
                strokeWidth={1}
                className="pointer-events-none absolute -bottom-10 -right-10 size-64 text-white/[0.06] transition duration-700 group-hover:scale-110 group-hover:text-white/10"
              />
              <div className="mk-blob pointer-events-none absolute -left-16 -top-16 size-56 rounded-full bg-primary/40 blur-3xl" />
              <div className="relative">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-[color:var(--mk-gold)]">
                  <Eye size={14} /> Our vision
                </span>
                <h3 className="mt-6 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                  Every venue running{' '}
                  <span className="bg-gradient-to-r from-white to-[color:var(--mk-gold)] bg-clip-text text-transparent">
                    smoothly, end to end.
                  </span>
                </h3>
                <p className="mt-5 max-w-md text-base leading-relaxed text-white/75 sm:text-lg">
                  We picture a future where owners spend their time on their guests and their craft, not on reconciling
                  spreadsheets. Where every booking, bill and customer visit simply works.
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal direction="right" delay={120} className="h-full">
            <div className="group relative h-full overflow-hidden rounded-[2rem] border border-border-strong bg-card p-8 shadow-xl shadow-primary/10 sm:p-12">
              <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-primary via-[#c0396b] to-[#d49a3a]" />
              <Target
                aria-hidden
                strokeWidth={1}
                className="pointer-events-none absolute -bottom-10 -right-10 size-64 text-primary/[0.06] transition duration-700 group-hover:scale-110 group-hover:text-primary/10"
              />
              <div className="relative">
                <span className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-accent px-3.5 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-accent-foreground">
                  <Target size={14} /> Our mission
                </span>
                <h3 className="mt-6 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                  Big-venue tools,{' '}
                  <span className="mk-gradient-text">made simple for every venue.</span>
                </h3>
                <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground sm:text-lg">
                  To bring bookings, billing, kitchen and reporting together in one reliable platform that any venue can
                  run from day one.
                </p>
                <ul className="mt-7 space-y-3.5">
                  {MISSION_POINTS.map((point) => (
                    <li key={point} className="flex items-start gap-3 text-sm font-medium sm:text-base">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check size={12} strokeWidth={3} />
                      </span>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

const VALUES: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Gauge,
    title: 'Accurate to the paisa',
    description: 'Every price, tax and total is calculated on the server and checked against the same rules everywhere it appears.',
  },
  {
    icon: ShieldCheck,
    title: 'Your data stays yours',
    description: 'Each business is isolated at the database level, and staff only see what their role allows.',
  },
  {
    icon: Users,
    title: 'Simple for the floor',
    description: 'Cashiers, kitchen and reception each get the screens they need — not a wall of settings.',
  },
  {
    icon: Lock,
    title: 'No double bookings',
    description: 'Overlaps are rejected by the database itself, whether a booking arrives online, at the desk or as a walk-in.',
  },
]

export function ValuesSection() {
  return (
    <section className="bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="What we care about"
          title="The principles behind the product."
          subtitle="Four things we won't compromise on."
        />
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {VALUES.map(({ icon: Icon, title, description }, i) => (
            <Reveal key={title} delay={i * 90} className="h-full">
              <div className="group h-full rounded-2xl border border-border-strong bg-card p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/10">
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition duration-300 group-hover:scale-110 group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon size={20} />
                </span>
                <h3 className="mt-5 text-lg font-bold tracking-tight">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

/** Dark closing band: who is behind Arena OS, and a route to Contact. */
export function BehindSection() {
  return (
    <section className="bg-background px-4 py-20 sm:px-6 sm:py-28">
      <Reveal direction="scale">
        <div className="mk-dark relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] px-6 py-16 text-center shadow-2xl shadow-primary/30 sm:px-12 sm:py-20">
          <div className="mk-blob pointer-events-none absolute -left-20 -top-20 size-72 rounded-full bg-primary/50 blur-3xl" />
          <div className="mk-blob pointer-events-none absolute -bottom-24 -right-16 size-72 rounded-full bg-[#d49a3a]/30 blur-3xl [animation-delay:-8s]" />
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--mk-gold)]">Built and powered by</p>
            <h2 className="mx-auto mt-3 max-w-2xl bg-gradient-to-b from-white to-[color:var(--mk-gold)] bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl">
              WnR Group
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/75 sm:text-lg">
              Arena OS is built for venues that want to spend less time on admin and more time with their customers.
              Have a question or want to see it in action? We&apos;d love to hear from you.
            </p>
            <div className="mt-9 flex justify-center">
              <Link
                href="/contact"
                className="mk-shine inline-flex w-full items-center justify-center rounded-xl bg-white px-8 py-3.5 text-base font-bold text-primary shadow-lg transition hover:-translate-y-0.5 hover:bg-white/90 sm:w-auto"
              >
                Contact us
              </Link>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
