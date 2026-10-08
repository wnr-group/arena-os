import { Reveal } from '../ui/Reveal'

/** Compact hero for the inner marketing pages — same dotted grid and drifting glows as the homepage hero. */
export function PageHero({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string
  title: React.ReactNode
  subtitle: string
  children?: React.ReactNode
}) {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div className="mk-grid-bg pointer-events-none absolute inset-0" />
      <div className="mk-blob pointer-events-none absolute -left-24 -top-10 size-[22rem] rounded-full bg-primary/20 blur-3xl" />
      <div className="mk-blob pointer-events-none absolute -right-24 top-10 size-[20rem] rounded-full bg-[#d49a3a]/20 blur-3xl [animation-delay:-6s]" />

      <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 sm:py-28">
        <Reveal>
          <span className="inline-flex items-center rounded-full border border-border-strong bg-background/80 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-accent-foreground shadow-sm backdrop-blur">
            {eyebrow}
          </span>
        </Reveal>
        <Reveal delay={100}>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl lg:leading-[1.06]">{title}</h1>
        </Reveal>
        <Reveal delay={200}>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">{subtitle}</p>
        </Reveal>
        {children && (
          <Reveal delay={300}>
            <div className="mt-8">{children}</div>
          </Reveal>
        )}
      </div>
    </section>
  )
}
