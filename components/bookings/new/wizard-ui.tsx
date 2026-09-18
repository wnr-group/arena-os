'use client'

import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'

/** Shared chrome for a wizard step's content (M21 #3) — no border/shadow, so
 *  it reads as part of the page rather than a boxed-in card. */
export function WizardCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="wizard-step-in py-2">
      {children}
    </div>
  )
}

/** Back / Continue (or submit) footer, sticky to the bottom of a step card. */
export function WizardFooter({
  onBack,
  backLabel = 'Back',
  onNext,
  nextLabel,
  nextDisabled,
  pending,
}: {
  onBack?: () => void
  backLabel?: string
  onNext: () => void
  nextLabel: string
  nextDisabled?: boolean
  pending?: boolean
}) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-6">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowLeft size={15} /> {backLabel}
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled || pending}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 size={15} className="animate-spin" /> : null}
        {nextLabel}
        {!pending && <ArrowRight size={15} />}
      </button>
    </div>
  )
}

/** A large selectable tile — the premium replacement for a plain <button> or
 *  <select> option, used for station/resource-type/mode pickers. */
export function SelectableTile({
  selected,
  onClick,
  icon,
  title,
  subtitle,
  badge,
  disabled,
}: {
  selected: boolean
  onClick: () => void
  icon?: React.ReactNode
  title: string
  subtitle?: string
  badge?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all duration-150 motion-safe:hover:-translate-y-0.5 ${
        selected
          ? 'border-primary bg-accent/60 shadow-[0_4px_16px_-6px_rgba(139,34,66,0.35)] ring-1 ring-primary/30'
          : 'border-border bg-card hover:border-primary/40 hover:shadow-sm'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {icon && (
        <span
          className={`flex size-9 items-center justify-center rounded-lg transition-colors ${
            selected ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'
          }`}
        >
          {icon}
        </span>
      )}
      <span className="text-sm font-semibold text-foreground">{title}</span>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      {badge && <span className="mt-0.5">{badge}</span>}
      {selected && (
        <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <svg viewBox="0 0 20 20" fill="currentColor" className="size-3">
            <path
              fillRule="evenodd"
              d="M16.704 5.29a1 1 0 010 1.415l-7.5 7.5a1 1 0 01-1.415 0l-3.5-3.5a1 1 0 111.415-1.414L8.5 12.086l6.79-6.796a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      )}
    </button>
  )
}

/** Placeholder for a SelectableTile while its options are still loading —
 *  same border/padding/icon-slot shape so the grid doesn't reflow once the
 *  real tiles arrive. */
export function SelectableTileSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-border bg-card p-4">
      <div className="size-9 rounded-lg bg-muted" />
      <div className="mt-3 h-3.5 w-3/4 rounded bg-muted" />
      <div className="mt-2 h-3 w-1/2 rounded bg-muted" />
    </div>
  )
}

/** A row of pill chips — used for duration and time-offset pickers instead
 *  of a native <select>. */
export function ChipRow({
  options,
  value,
  onChange,
}: {
  options: { value: number; label: string }[]
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
            value === o.value
              ? 'border-primary bg-primary text-primary-foreground shadow-sm'
              : 'border-border bg-card text-foreground hover:border-primary/40 hover:bg-accent/40'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export const wizardInput =
  'w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40'
export const wizardLabel = 'text-sm font-medium text-foreground'
export const wizardHint = 'mt-1 text-xs text-muted-foreground'
export const wizardError = 'mt-1 text-sm text-destructive'
