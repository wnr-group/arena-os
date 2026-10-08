import {
  BadgeCheck,
  CalendarClock,
  Gift,
  Globe,
  QrCode,
  Ticket,
  Timer,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { Reveal } from '../ui/Reveal'
import { SectionHeading } from '../ui/SectionHeading'

const ITEMS: { icon: LucideIcon; title: string; description: string; wide?: boolean }[] = [
  {
    icon: Globe,
    title: 'Website builder',
    description: 'Hero, gallery-style sections, menu, hours and map — build your homepage without a developer.',
    wide: true,
  },
  { icon: Timer, title: 'Happy hours', description: 'Time-based discounts that apply live, online and at the counter.' },
  { icon: BadgeCheck, title: 'Memberships', description: 'Sell plans and apply member benefits at billing.' },
  { icon: Wallet, title: 'Wallet & advances', description: 'Prepaid wallets and split-tender advances, tracked in a ledger.' },
  { icon: Gift, title: 'Loyalty tiers', description: 'Points and tiers that keep customers coming back.' },
  { icon: Ticket, title: 'Promo codes', description: 'Discount codes with limits you control.' },
  { icon: QrCode, title: 'QR check-in', description: 'Scan a booking QR at the door and start the session.' },
  {
    icon: CalendarClock,
    title: 'Customer portal',
    description: 'Customers log in with their phone to see bookings, rebook and view their wallet.',
    wide: true,
  },
]

export function BentoGrid() {
  return (
    <section className="bg-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="And so much more"
          title="Every detail, already thought through."
          subtitle="The small things that make a venue run smoothly are built in, not bolted on."
        />

        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ITEMS.map(({ icon: Icon, title, description, wide }, i) => (
            <Reveal key={title} delay={(i % 4) * 80} className={wide ? 'lg:col-span-2' : undefined}>
              <div className="group relative h-full overflow-hidden rounded-2xl border border-border-strong bg-card p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/10">
                <div className="pointer-events-none absolute -right-10 -top-10 size-32 rounded-full bg-primary/10 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />
                <span className="relative inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition duration-300 group-hover:scale-110 group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon size={20} />
                </span>
                <h3 className="relative mt-5 text-lg font-bold tracking-tight">{title}</h3>
                <p className="relative mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
