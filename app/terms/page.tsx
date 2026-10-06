import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getContactDetails } from '@/lib/marketing/contact'
import { ContactParagraph, LegalLayout, type LegalSection } from '@/components/marketing/legal/LegalLayout'

const TITLE = 'Terms & Conditions — Arena OS'
const DESCRIPTION = 'The terms that apply when you use Arena OS.'
const UPDATED = '6 October 2026'

export async function generateMetadata(): Promise<Metadata> {
  if (await currentTenantSlug()) return {}
  return { title: TITLE, description: DESCRIPTION, openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' } }
}

/** Platform Terms & Conditions — root domain only (404 on a tenant subdomain, like the other marketing pages). */
export default async function TermsPage() {
  if (await currentTenantSlug()) notFound()

  const { email } = getContactDetails()

  const sections: LegalSection[] = [
    {
      id: 'agreement',
      title: 'Agreement to these terms',
      content: (
        <>
          <p>
            These terms are an agreement between you and WnR Group (“Arena OS”, “we”, “us”) for your use of the Arena OS
            platform, website and related services. By creating an account or using the service, you agree to them. If
            you are using Arena OS for a business, you confirm that you can bind that business to these terms.
          </p>
          <p>
            If you do not agree, please do not use the service. Our <Link href="/privacy">Privacy Policy</Link> explains
            how personal information is handled and forms part of this agreement.
          </p>
        </>
      ),
    },
    {
      id: 'the-service',
      title: 'The service',
      content: (
        <p>
          Arena OS is a platform for venues to take bookings, run walk-ins, bill customers, take food orders, manage
          staff and see reports, and to publish their own booking website. Features depend on the plan you choose, and we
          may improve, change or retire features over time.
        </p>
      ),
    },
    {
      id: 'accounts',
      title: 'Accounts and staff',
      content: (
        <>
          <ul>
            <li>You must give accurate information and keep it up to date.</li>
            <li>You are responsible for keeping your sign-in details safe and for everything done under your account.</li>
            <li>
              The owner of a workspace decides who on their team has access and what role they have, and is responsible
              for what those people do.
            </li>
            <li>Tell us promptly if you think your account has been used without your permission.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'plans-and-billing',
      title: 'Plans, fees and billing',
      content: (
        <>
          <p>
            Arena OS is offered on paid plans, billed monthly or yearly in advance at the price shown when you choose
            your plan. Taxes, including GST, are added where they apply, and we issue a tax invoice for each charge.
          </p>
          <p>
            If a renewal payment fails, we will let you know and give you a grace period to put it right. If it is still
            unpaid after that, we may restrict access to the service, and eventually cancel the subscription. Restricting
            access does not delete your data.
          </p>
          <p>
            You can cancel at any time and the plan will not renew. Refund requests are looked at case by case — please
            contact us.
          </p>
        </>
      ),
    },
    {
      id: 'your-data',
      title: 'Your data and your customers',
      content: (
        <>
          <p>
            You keep ownership of the information you put into Arena OS. You give us permission to store and process it
            only to provide the service to you.
          </p>
          <p>
            You are responsible for having the right to enter your customers’ information, for telling them how you use
            it, and for getting any consent the law requires. For that information, you decide how it is used and we
            process it on your behalf.
          </p>
        </>
      ),
    },
    {
      id: 'your-customers-and-payments',
      title: 'Payments between you and your customers',
      content: (
        <>
          <p>
            Bookings, orders and sales made through Arena OS are between your venue and your customer. We are not a
            party to them. You are responsible for your prices, your refund and cancellation rules, and the goods and
            services you provide.
          </p>
          <p>
            Online payments are processed by a payment gateway under that gateway’s own terms, using the account you
            connect. Arena OS calculates prices and taxes from the settings you configure, so you are responsible for
            keeping those settings — rates, tax details and invoice information — correct.
          </p>
        </>
      ),
    },
    {
      id: 'acceptable-use',
      title: 'Acceptable use',
      content: (
        <>
          <p>You agree not to:</p>
          <ul>
            <li>break the law or use Arena OS for anything fraudulent or harmful;</li>
            <li>upload content that is unlawful or that you have no right to share;</li>
            <li>try to access another business’s data, or to probe, disrupt or overload the service;</li>
            <li>copy, resell or reverse-engineer the service, except as the law allows; or</li>
            <li>send spam or unwanted messages through the service.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'our-rights',
      title: 'Our intellectual property',
      content: (
        <p>
          Arena OS, including its software, design, logo and name, belongs to us and our licensors. These terms give you
          the right to use the service, not to own any part of it. If you send us feedback, we may use it to improve the
          product without owing you anything.
        </p>
      ),
    },
    {
      id: 'availability',
      title: 'Availability and changes',
      content: (
        <p>
          We work to keep Arena OS running reliably, but we cannot promise it will always be uninterrupted or free of
          errors. We may carry out maintenance, and we may make changes to the service. Where a change is significant,
          we will try to give you notice.
        </p>
      ),
    },
    {
      id: 'suspension',
      title: 'Suspension and ending the agreement',
      content: (
        <p>
          You may stop using Arena OS at any time. We may suspend or end your access if you break these terms, if
          payment is not made, if we are required to by law, or if your use puts the service or other users at risk.
          Where it is reasonable to do so, we will tell you why and give you a chance to fix the problem first.
        </p>
      ),
    },
    {
      id: 'disclaimers',
      title: 'Disclaimers',
      content: (
        <p>
          The service is provided “as is” and “as available”. To the extent the law allows, we do not give any
          warranties beyond those that cannot be excluded — including that the service will meet every one of your needs.
          Reports and calculations depend on the information you enter, and you should check them before relying on them
          for accounting or tax filings.
        </p>
      ),
    },
    {
      id: 'liability',
      title: 'Limits on our liability',
      content: (
        <>
          <p>
            To the extent the law allows, we are not liable for indirect or consequential losses, or for lost profit,
            revenue or data. Our total liability for any claim relating to the service is limited to the fees you paid us
            in the 12 months before the claim arose.
          </p>
          <p>Nothing in these terms limits liability that cannot be limited by law.</p>
        </>
      ),
    },
    {
      id: 'governing-law',
      title: 'Governing law',
      content: (
        <p>
          These terms are governed by the laws of India. We would like to resolve any disagreement by talking to you
          first, so please contact us before starting a formal process.
        </p>
      ),
    },
    {
      id: 'changes',
      title: 'Changes to these terms',
      content: (
        <p>
          We may update these terms from time to time. The “last updated” date at the top shows the latest version. If a
          change is significant, we will tell account holders in advance, and continuing to use Arena OS after a change
          takes effect means you accept it.
        </p>
      ),
    },
    {
      id: 'contact',
      title: 'Contact us',
      content: <ContactParagraph email={email} lead="Questions about these terms?" />,
    },
  ]

  return (
    <LegalLayout
      eyebrow="Legal"
      title={
        <>
          Terms &amp; <span className="mk-gradient-text">Conditions.</span>
        </>
      }
      intro="The ground rules for using Arena OS, written to be read."
      updated={UPDATED}
      sections={sections}
    />
  )
}
