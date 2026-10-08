'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

const VENUE_TYPES = [
  'Gaming café',
  'Recording studio',
  'Podcast studio',
  'Dance studio',
  'VR centre',
  'Restaurant',
  'Something else',
]

const FIELD =
  'w-full rounded-xl border border-border-strong bg-background px-4 py-3 text-sm outline-none transition placeholder:text-subtle-foreground focus:border-primary focus:ring-4 focus:ring-ring'

/**
 * Contact form. There is deliberately no server round-trip: on submit it opens the visitor's own email app with a
 * pre-filled message addressed to the configured Arena OS address (`MARKETING_CONTACT_EMAIL`). Nothing is stored
 * or relayed by us, so there is no inbox to run and no spam endpoint to protect. With no address configured the
 * form is disabled rather than pretending to send.
 */
export function ContactForm({ toEmail }: { toEmail: string | null }) {
  const [sent, setSent] = useState(false)

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!toEmail) return
    const f = new FormData(e.currentTarget)
    const get = (k: string) => String(f.get(k) ?? '').trim()

    const subject = `Arena OS enquiry — ${get('venueType') || 'New venue'}`
    const lines = [`Name: ${get('name')}`, `Email: ${get('email')}`]
    if (get('phone')) lines.push(`Phone: ${get('phone')}`)
    if (get('venueType')) lines.push(`Venue type: ${get('venueType')}`)
    lines.push('', get('message'))
    const body = lines.join('\n')

    window.location.href = `mailto:${toEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    setSent(true)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold">Your name</span>
          <input name="name" required maxLength={100} autoComplete="name" placeholder="Priya Sharma" className={FIELD} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold">Email</span>
          <input
            name="email"
            type="email"
            required
            maxLength={150}
            autoComplete="email"
            placeholder="you@yourvenue.com"
            className={FIELD}
          />
        </label>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold">
            Phone <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <input name="phone" type="tel" maxLength={30} autoComplete="tel" placeholder="+91 98765 43210" className={FIELD} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold">Type of venue</span>
          <select name="venueType" defaultValue="" className={FIELD}>
            <option value="">Select…</option>
            {VENUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">How can we help?</span>
        <textarea
          name="message"
          required
          rows={5}
          maxLength={2000}
          placeholder="Tell us about your venue and what you're looking for…"
          className={cn(FIELD, 'resize-y')}
        />
      </label>

      <button
        type="submit"
        disabled={!toEmail}
        className="mk-shine inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-7 py-3.5 text-base font-bold text-primary-foreground shadow-lg shadow-primary/25 transition hover:-translate-y-0.5 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 sm:w-auto"
      >
        <Send size={17} />
        Send message
      </button>

      {!toEmail && (
        <p className="text-sm text-muted-foreground">
          The contact form isn&apos;t switched on yet — no email address has been configured for this site.
        </p>
      )}
      {sent && toEmail && (
        <p role="status" className="rounded-xl border border-mint-border bg-mint-bg px-4 py-3 text-sm font-medium text-mint">
          Your email app should have opened with the message ready to send. If nothing happened, write to us at{' '}
          <a href={`mailto:${toEmail}`} className="font-bold underline">
            {toEmail}
          </a>
          .
        </p>
      )}
    </form>
  )
}
