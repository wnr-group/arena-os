import { ChevronDown } from 'lucide-react'
import { Reveal } from '../ui/Reveal'
import { SectionHeading } from '../ui/SectionHeading'

const FAQS = [
  {
    q: 'How do my customers book?',
    a: 'Every venue gets its own branded booking site on its own subdomain. Customers see live availability, choose a time, optionally pay online, and receive a QR confirmation they can scan at the door.',
  },
  {
    q: 'Does it handle GST invoices?',
    a: 'Yes. Bills are raised as GST invoices with CGST/SGST split, configurable tax rates and optional HSN/SAC codes. You can split bills, apply promo codes and issue refunds.',
  },
  {
    q: 'Which kinds of businesses is it for?',
    a: 'Gaming cafés, recording and podcast studios, dance studios, VR centres and restaurants. Each industry gets the right setup — for example table service for restaurants and studio setups for studios.',
  },
  {
    q: 'Where do online payments go?',
    a: 'Straight to your own Razorpay account. You add your keys in settings, and they are stored encrypted. Arena OS never holds your customers’ money.',
  },
  {
    q: 'Can I run walk-ins as well as online bookings?',
    a: 'Absolutely. Start a timed or open walk-in session, add food, and bill by elapsed time with happy-hour, weekend and holiday rates applied automatically.',
  },
  {
    q: 'Is my business data safe from other venues?',
    a: 'Yes. Every business’s data is isolated at the database level with row-level security, and staff only see what their role allows.',
  },
  {
    q: 'How do I get started?',
    a: 'Create your workspace, pick a plan, then add your resources, hours, menu and team. Share your booking link and you are live.',
  },
]

/** Native <details> accordion — no JavaScript, keyboard- and screen-reader-friendly by default. */
export function Faq() {
  return (
    <section id="faq" className="scroll-mt-16 bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <SectionHeading eyebrow="FAQ" title="Questions, answered." />

        <div className="mt-12 space-y-3">
          {FAQS.map((f, i) => (
            <Reveal key={f.q} delay={i * 50}>
              <details className="group rounded-2xl border border-border-strong bg-card shadow-sm transition-colors open:border-primary/40 open:shadow-md">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-6 py-5 text-left font-semibold [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-transform duration-300 group-open:rotate-180">
                    <ChevronDown size={16} />
                  </span>
                </summary>
                <p className="mk-faq-body px-6 pb-5 text-sm leading-relaxed text-muted-foreground sm:text-base">{f.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
