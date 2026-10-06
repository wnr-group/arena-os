import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getContactDetails } from '@/lib/marketing/contact'
import { ContactParagraph, LegalLayout, type LegalSection } from '@/components/marketing/legal/LegalLayout'

const TITLE = 'Privacy Policy — Arena OS'
const DESCRIPTION = 'How Arena OS collects, uses and protects personal information.'
const UPDATED = '6 October 2026'

export async function generateMetadata(): Promise<Metadata> {
  if (await currentTenantSlug()) return {}
  return { title: TITLE, description: DESCRIPTION, openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' } }
}

/** Platform Privacy Policy — root domain only (404 on a tenant subdomain, like /signup, /about and /contact). */
export default async function PrivacyPage() {
  if (await currentTenantSlug()) notFound()

  const { email } = getContactDetails()

  const sections: LegalSection[] = [
    {
      id: 'introduction',
      title: 'Introduction',
      content: (
        <>
          <p>
            Arena OS is a booking, point-of-sale and venue-management platform operated by WnR Group (“Arena OS”, “we”,
            “us”). This policy explains what personal information we handle, why we handle it, and the choices you
            have. It covers this website, the Arena OS dashboard used by venues and their staff, and the booking sites
            and customer accounts that venues run on Arena OS.
          </p>
          <p>
            <strong>Two roles matter here.</strong> For the people who sign up to run a venue (owners, managers and
            staff), we decide how their information is used. For a venue’s own customers, the venue decides why and how
            their information is used, and we process it on the venue’s behalf. If you are a customer of a venue and
            want to see, correct or delete your booking information, please contact that venue first.
          </p>
        </>
      ),
    },
    {
      id: 'information-we-collect',
      title: 'Information we collect',
      content: (
        <>
          <ul>
            <li>
              <strong>Account details</strong> — name, email address and a password (stored only as a one-way hash) for
              the people who use the dashboard.
            </li>
            <li>
              <strong>Venue information</strong> — business name, address, working hours, resources, prices, menu,
              staff, rosters, attendance and payroll details that a venue enters.
            </li>
            <li>
              <strong>Customer information entered by venues or customers</strong> — name, phone number, bookings,
              orders, invoices, wallet and loyalty balances, and notes.
            </li>
            <li>
              <strong>Sign-in details for customers</strong> — a phone number and the one-time code used to log in to a
              customer account.
            </li>
            <li>
              <strong>Payment records</strong> — amounts, status and references of payments and refunds. We do not
              store card or UPI credentials.
            </li>
            <li>
              <strong>Technical data</strong> — IP address and basic request information, used to keep the service
              secure and to limit abuse.
            </li>
            <li>
              <strong>Messages to us</strong> — what you send through our contact page or by email.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'how-we-use-it',
      title: 'How we use information',
      content: (
        <>
          <p>We use information to:</p>
          <ul>
            <li>provide the service — create bookings, run walk-ins, raise invoices, process orders and show reports;</li>
            <li>sign you in and keep your account secure;</li>
            <li>send service messages such as booking confirmations, one-time codes and billing notices;</li>
            <li>bill venues for their subscription and keep the records the law requires;</li>
            <li>prevent fraud and abuse, and fix problems; and</li>
            <li>answer your questions and improve the product.</li>
          </ul>
          <p>We do not sell personal information.</p>
        </>
      ),
    },
    {
      id: 'payments',
      title: 'Payments',
      content: (
        <p>
          Online payments are handled by payment gateway partners, not by us. Card, UPI and bank details go directly to
          the gateway and never reach Arena OS. Each venue connects its own payment account, and the access details for
          that account are stored encrypted. We receive only the result of a payment — such as the amount and whether it
          succeeded — so we can show it on the booking and the invoice.
        </p>
      ),
    },
    {
      id: 'cookies',
      title: 'Cookies',
      content: (
        <p>
          We use only the cookies needed to keep you signed in. They are marked HTTP-only so scripts on a page cannot
          read them, and they are used for nothing else. We do not use advertising or cross-site tracking cookies. If
          you block these cookies, you will not be able to sign in.
        </p>
      ),
    },
    {
      id: 'sharing',
      title: 'Who we share information with',
      content: (
        <>
          <p>We share information only where needed to run the service:</p>
          <ul>
            <li>
              <strong>Service providers</strong> that host our application and database, store uploaded files, deliver
              text messages and one-time codes, and process payments — each only for those purposes.
            </li>
            <li>
              <strong>The venue</strong> you book with or order from, which sees the details you give it.
            </li>
            <li>
              <strong>Authorities</strong>, where the law requires it or to protect people and our service.
            </li>
            <li>
              <strong>A successor</strong>, if Arena OS is merged with or acquired by another business, in which case
              this policy will continue to apply to your information until you are told otherwise.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'security',
      title: 'Security and data separation',
      content: (
        <>
          <p>
            Each venue’s data is kept separate from every other venue’s at the database level, and people inside a venue
            only see what their role allows. Passwords are stored as hashes, and sensitive secrets such as payment
            access details are encrypted.
          </p>
          <p>
            No system is perfectly secure, so we cannot promise absolute security. If we learn of a breach that affects
            you, we will tell you as the law requires.
          </p>
        </>
      ),
    },
    {
      id: 'retention',
      title: 'How long we keep it',
      content: (
        <p>
          We keep information for as long as an account is active and as long as we need it to meet legal, tax and
          accounting duties — for example, keeping GST invoices. When information is no longer needed, we delete it or
          make it anonymous.
        </p>
      ),
    },
    {
      id: 'your-rights',
      title: 'Your rights',
      content: (
        <>
          <p>
            Subject to applicable law, including India’s Digital Personal Data Protection Act, 2023, you can ask to
            access the personal information we hold about you, correct it, have it erased, or withdraw consent you have
            given. You can also raise a complaint with us.
          </p>
          <p>
            If your information was entered by a venue — for example, a booking you made — start by asking that venue,
            as it decides how that information is used. We will help the venue respond.
          </p>
        </>
      ),
    },
    {
      id: 'children',
      title: 'Children',
      content: (
        <p>
          Arena OS is a business tool. We do not knowingly collect personal information from children for our own
          purposes. Venues are responsible for handling lawfully any information about minors that they enter, including
          getting any parental consent the law requires.
        </p>
      ),
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      content: (
        <p>
          We may update this policy as the product or the law changes. The “last updated” date at the top shows the
          latest version, and if a change is significant we will tell account holders directly. Please also see our{' '}
          <Link href="/terms">Terms &amp; Conditions</Link>.
        </p>
      ),
    },
    {
      id: 'contact',
      title: 'Contact us',
      content: <ContactParagraph email={email} lead="Questions, requests or complaints about privacy?" />,
    },
  ]

  return (
    <LegalLayout
      eyebrow="Legal"
      title={
        <>
          Privacy <span className="mk-gradient-text">Policy.</span>
        </>
      }
      intro="What we collect, why we collect it, and how we look after it."
      updated={UPDATED}
      sections={sections}
    />
  )
}
