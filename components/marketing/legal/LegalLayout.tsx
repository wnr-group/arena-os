import Link from 'next/link'
import type { ReactNode } from 'react'
import { MarketingShell } from '../MarketingShell'
import { PageHero } from '../sections/PageHero'
import { Reveal } from '../ui/Reveal'

export type LegalSection = { id: string; title: string; content: ReactNode }

/**
 * Shared frame for the legal pages (Privacy Policy, Terms & Conditions): a hero, a sticky numbered contents list on
 * desktop, and the numbered sections as readable prose. There is no typography plugin in this project, so the prose
 * styling for paragraphs, lists and links lives on the section body below.
 */
export function LegalLayout({
  eyebrow,
  title,
  intro,
  updated,
  sections,
}: {
  eyebrow: string
  title: ReactNode
  intro: string
  /** Human-readable date, e.g. "6 October 2026". */
  updated: string
  sections: LegalSection[]
}) {
  return (
    <MarketingShell>
      <PageHero eyebrow={eyebrow} title={title} subtitle={intro}>
        <span className="inline-flex items-center rounded-full border border-border-strong bg-card px-4 py-1.5 text-sm font-medium text-muted-foreground shadow-sm">
          Last updated {updated}
        </span>
      </PageHero>

      <section className="bg-background py-14 sm:py-20">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-16">
          <aside className="hidden lg:block">
            <nav aria-label="On this page" className="sticky top-24">
              <p className="px-3 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">On this page</p>
              <ol className="mt-3 space-y-0.5">
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="flex gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
                    >
                      <span className="w-5 shrink-0 tabular-nums text-subtle-foreground">{String(i + 1).padStart(2, '0')}</span>
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>

          <div className="min-w-0 space-y-12">
            {sections.map((s, i) => (
              <Reveal key={s.id}>
                <section id={s.id} className="scroll-mt-24">
                  <h2 className="flex items-center gap-3 text-xl font-extrabold tracking-tight sm:text-2xl">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-md shadow-primary/25">
                      {i + 1}
                    </span>
                    {s.title}
                  </h2>
                  <div className="mt-4 space-y-4 text-base leading-relaxed text-muted-foreground [&_a]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
                    {s.content}
                  </div>
                </section>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </MarketingShell>
  )
}

/** The closing "how to reach us" paragraph: the configured email when there is one, the Contact page otherwise. */
export function ContactParagraph({ email, lead }: { email: string | null; lead: string }) {
  return (
    <p>
      {lead}{' '}
      {email ? (
        <>
          Email us at <a href={`mailto:${email}`}>{email}</a>, or use our <Link href="/contact">contact page</Link>.
        </>
      ) : (
        <>
          Please reach us through our <Link href="/contact">contact page</Link>.
        </>
      )}
    </p>
  )
}
