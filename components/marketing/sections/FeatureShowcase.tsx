import { Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Reveal } from '../ui/Reveal'
import { SectionHeading } from '../ui/SectionHeading'
import { KitchenMockup, PosMockup, ReportsMockup, SiteMockup } from '../mockups/FeatureMockups'

const FEATURES: {
  eyebrow: string
  title: string
  description: string
  bullets: string[]
  mockup: React.ReactNode
}[] = [
  {
    eyebrow: 'Online storefront',
    title: 'A booking site that fills your calendar while you sleep.',
    description:
      'Every venue gets its own branded site. Customers see live availability, pick a time and pay a deposit — all from their phone.',
    bullets: ['Live availability, no double bookings', 'Online deposits and pay-now via Razorpay', 'QR confirmation and one-scan check-in'],
    mockup: <SiteMockup />,
  },
  {
    eyebrow: 'Walk-ins & POS',
    title: 'From the first minute to the final GST invoice.',
    description:
      'Start a timer for a walk-in, add food, apply happy hours and split the bill. Pricing is calculated for you, to the paisa.',
    bullets: ['Timed and open sessions with elapsed-time pricing', 'Happy hours, weekend and holiday rates', 'Split bills, advances, wallet and UPI'],
    mockup: <PosMockup />,
  },
  {
    eyebrow: 'Kitchen & food',
    title: 'Orders reach the kitchen the moment they are placed.',
    description:
      'Dine-in, table QR and online orders flow into one live kitchen queue, with KOT printing and out-of-stock controls.',
    bullets: ['Live kitchen queue with KOT tickets', 'Table service, seat tagging and bill splitting', 'Void and comp approvals for managers'],
    mockup: <KitchenMockup />,
  },
  {
    eyebrow: 'Team & money',
    title: 'Know exactly how the business is doing.',
    description:
      'Revenue, expenses and payroll roll into a single profit-and-loss view, with attendance and rosters for your staff.',
    bullets: ['Revenue, sales and P&L reports with CSV export', 'Attendance, rosters, payroll and payslips', 'Role-based access for every team member'],
    mockup: <ReportsMockup />,
  },
]

export function FeatureShowcase() {
  return (
    <section id="features" className="scroll-mt-16 bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="The platform"
          title={
            <>
              Everything your venue needs, <span className="mk-gradient-text">working together.</span>
            </>
          }
          subtitle="Stop juggling a booking app, a billing tool, a kitchen printer and a spreadsheet."
        />

        <div className="mt-20 space-y-24 sm:space-y-32">
          {FEATURES.map((f, i) => {
            const flip = i % 2 === 1
            return (
              <div key={f.eyebrow} className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
                <Reveal direction={flip ? 'right' : 'left'} className={cn(flip && 'lg:order-2')}>
                  <span className="text-xs font-bold uppercase tracking-[0.16em] text-primary">{f.eyebrow}</span>
                  <h3 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">{f.title}</h3>
                  <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">{f.description}</p>
                  <ul className="mt-6 space-y-3">
                    {f.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-3 text-sm font-medium sm:text-base">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check size={12} strokeWidth={3} />
                        </span>
                        {b}
                      </li>
                    ))}
                  </ul>
                </Reveal>

                <Reveal direction={flip ? 'left' : 'right'} delay={120} className={cn(flip && 'lg:order-1')}>
                  <div className="relative rounded-[2rem] bg-gradient-to-br from-accent via-rose-bg/60 to-accent px-6 py-12 sm:px-10 sm:py-14">
                    <div className="mk-blob pointer-events-none absolute -right-6 -top-6 size-40 rounded-full bg-primary/15 blur-2xl" />
                    <div className="relative">{f.mockup}</div>
                  </div>
                </Reveal>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
