import { cn } from '@/lib/utils/cn'

/**
 * The "Arena OS" text that sits beside the logo mark: a tight, heavy "Arena" with "OS" set as a small gradient
 * badge. `tone` picks the palette for the surface it sits on — wine on light, gold on the dark footer. When the
 * parent carries Tailwind's `group` class the badge tilts and lifts on hover.
 */
export function ArenaWordmark({ tone = 'light', className }: { tone?: 'light' | 'dark'; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 leading-none', className)}>
      <span className={cn('text-[1.4rem] font-extrabold tracking-[-0.045em]', tone === 'dark' ? 'text-white' : 'text-foreground')}>
        Arena
      </span>
      <span
        className={cn(
          'rounded-md px-1.5 py-1 text-[0.7rem] font-black uppercase tracking-[0.2em] shadow-sm transition duration-300 group-hover:-rotate-3 group-hover:scale-110',
          tone === 'dark'
            ? 'bg-gradient-to-br from-[#e3b565] to-[#d49a3a] text-[#34122a] shadow-black/30'
            : 'bg-gradient-to-br from-primary to-[#c0396b] text-white shadow-primary/30',
        )}
      >
        OS
      </span>
    </span>
  )
}
