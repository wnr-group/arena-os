import { cn } from '@/lib/utils/cn'
import { Reveal } from './Reveal'

/** Eyebrow pill + big title + subtitle, the opener for every marketing section. */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  invert = false,
}: {
  eyebrow: string
  title: React.ReactNode
  subtitle?: string
  align?: 'center' | 'left'
  /** For the dark band. */
  invert?: boolean
}) {
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center')}>
      <Reveal>
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em]',
            invert ? 'border-white/20 bg-white/10 text-white/80' : 'border-border-strong bg-accent text-accent-foreground',
          )}
        >
          {eyebrow}
        </span>
      </Reveal>
      <Reveal delay={80}>
        <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl lg:text-5xl lg:leading-[1.1]">{title}</h2>
      </Reveal>
      {subtitle && (
        <Reveal delay={160}>
          <p className={cn('mt-4 text-base leading-relaxed sm:text-lg', invert ? 'text-white/70' : 'text-muted-foreground')}>
            {subtitle}
          </p>
        </Reveal>
      )}
    </div>
  )
}
