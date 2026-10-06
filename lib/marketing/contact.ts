import 'server-only'

/**
 * How visitors can reach Arena OS, read from the environment so a real address/number is never hard-coded
 * (or invented) in the source. Anything unset is null and the Contact page simply doesn't show it.
 *
 *   MARKETING_CONTACT_EMAIL     e.g. hello@yourdomain.com   → mailto: link + the contact form's destination
 *   MARKETING_CONTACT_PHONE     e.g. +91 98765 43210        → tel: link
 *   MARKETING_CONTACT_WHATSAPP  e.g. +91 98765 43210        → wa.me link
 *   MARKETING_CONTACT_ADDRESS   e.g. a single-line postal address
 */
export type ContactDetails = {
  email: string | null
  phone: string | null
  /** Digits only, as wa.me expects (no +, spaces or dashes). */
  whatsappDigits: string | null
  /** The number as the operator typed it, for display. */
  whatsappDisplay: string | null
  address: string | null
}

function clean(value: string | undefined): string | null {
  const v = value?.trim()
  return v ? v : null
}

export function getContactDetails(): ContactDetails {
  const email = clean(process.env.MARKETING_CONTACT_EMAIL)
  const whatsapp = clean(process.env.MARKETING_CONTACT_WHATSAPP)
  const whatsappDigits = whatsapp ? whatsapp.replace(/\D/g, '') : ''

  return {
    // A loose shape check only — this is operator-supplied config, not user input.
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    phone: clean(process.env.MARKETING_CONTACT_PHONE),
    whatsappDigits: whatsappDigits.length >= 8 ? whatsappDigits : null,
    whatsappDisplay: whatsappDigits.length >= 8 ? whatsapp : null,
    address: clean(process.env.MARKETING_CONTACT_ADDRESS),
  }
}
