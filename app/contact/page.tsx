import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HelpCircle, Mail, MapPin, MessageCircle, Phone, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getContactDetails } from '@/lib/marketing/contact'
import { MarketingShell } from '@/components/marketing/MarketingShell'
import { ContactForm } from '@/components/marketing/ContactForm'
import { PageHero } from '@/components/marketing/sections/PageHero'
import { Reveal } from '@/components/marketing/ui/Reveal'

const TITLE = 'Contact — Arena OS'
const DESCRIPTION = 'Talk to the Arena OS team about running your venue on one platform.'

export async function generateMetadata(): Promise<Metadata> {
  if (await currentTenantSlug()) return {}
  return { title: TITLE, description: DESCRIPTION, openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' } }
}

type Method = { icon: LucideIcon; label: string; value: string; href?: string }

const CARD =
  'group flex items-start gap-4 rounded-2xl border border-border-strong bg-card p-5 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10'
const ICON =
  'flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition duration-300 group-hover:bg-primary group-hover:text-primary-foreground'

/**
 * Platform "Contact" page — root domain only (404 on a tenant subdomain, like /signup). Which contact methods
 * appear is driven entirely by MARKETING_CONTACT_* env vars (lib/marketing/contact.ts); nothing is hard-coded.
 */
export default async function ContactPage() {
  if (await currentTenantSlug()) notFound()

  const c = getContactDetails()
  const methods: Method[] = []
  if (c.email) methods.push({ icon: Mail, label: 'Email', value: c.email, href: `mailto:${c.email}` })
  if (c.phone) methods.push({ icon: Phone, label: 'Phone', value: c.phone, href: `tel:${c.phone.replace(/[^\d+]/g, '')}` })
  if (c.whatsappDigits && c.whatsappDisplay)
    methods.push({
      icon: MessageCircle,
      label: 'WhatsApp',
      value: c.whatsappDisplay,
      href: `https://wa.me/${c.whatsappDigits}`,
    })
  if (c.address) methods.push({ icon: MapPin, label: 'Address', value: c.address })

  return (
    <MarketingShell>
      <PageHero
        eyebrow="Contact"
        title={
          <>
            Let&apos;s talk about <span className="mk-gradient-text">your venue.</span>
          </>
        }
        subtitle="Questions about plans, setup or how Arena OS fits your business? Send us a note and we'll get back to you."
      />

      <section className="bg-background py-16 sm:py-24">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-5 lg:gap-14">
          <div className="space-y-4 lg:col-span-2">
            {methods.map((m, i) => {
              const Inner = (
                <>
                  <span className={ICON}>
                    <m.icon size={20} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{m.label}</p>
                    <p className="mt-1 break-words font-semibold">{m.value}</p>
                  </div>
                </>
              )
              return (
                <Reveal key={m.label} delay={i * 80}>
                  {m.href ? (
                    <a
                      href={m.href}
                      {...(m.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      className={CARD}
                    >
                      {Inner}
                    </a>
                  ) : (
                    <div className={CARD}>{Inner}</div>
                  )}
                </Reveal>
              )
            })}

            <Reveal delay={methods.length * 80}>
              <div className="rounded-2xl border border-border-strong bg-muted p-5">
                <p className="font-bold tracking-tight">Prefer to look around first?</p>
                <div className="mt-3 space-y-2 text-sm">
                  <Link href="/#faq" className="flex items-center gap-2.5 font-medium text-primary hover:underline">
                    <HelpCircle size={16} /> Read the FAQ
                  </Link>
                </div>
              </div>
            </Reveal>
          </div>

          <Reveal direction="right" delay={120} className="lg:col-span-3">
            <div className="mk-card-glow rounded-3xl border border-border-strong bg-card p-6 sm:p-9">
              <h2 className="text-2xl font-extrabold tracking-tight">Send us a message</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">Tell us a little about your venue and we&apos;ll take it from there.</p>
              <div className="mt-7">
                <ContactForm toEmail={c.email} />
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  )
}
