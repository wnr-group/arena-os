'use client'

import type { LucideIcon } from 'lucide-react'
import { Check, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Shared shell for the cards on the Working hours settings page: an icon tile,
 * title + description, the controls, and a footer save bar. Keeps every card on
 * the page looking like one system.
 */
export function SettingsCard({
  icon: Icon,
  title,
  description,
  children,
  footer,
}: {
  icon: LucideIcon
  title: string
  description: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-start gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-6">{title}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </header>
      <div className="px-5 py-5 sm:px-6">{children}</div>
      {footer && <footer className="border-t border-border bg-muted/40 px-5 py-3.5 sm:px-6">{footer}</footer>}
    </section>
  )
}

/** Footer for a SettingsCard: error / saved status on the left, save button on the right. */
export function SaveBar({
  onSave,
  disabled,
  pending,
  saved,
  error,
  label = 'Save changes',
}: {
  onSave: () => void
  disabled?: boolean
  pending: boolean
  saved: boolean
  error?: string | null
  label?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-h-5 text-sm" aria-live="polite">
        {error ? (
          <span className="text-destructive" role="alert">
            {error}
          </span>
        ) : saved && !pending ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <Check size={15} aria-hidden /> Saved
          </span>
        ) : disabled ? (
          <span className="text-muted-foreground">No unsaved changes</span>
        ) : (
          <span className="text-muted-foreground">You have unsaved changes</span>
        )}
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={pending || disabled}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending && <Loader2 size={15} className="animate-spin" aria-hidden />}
        {pending ? 'Saving…' : label}
      </button>
    </div>
  )
}

/** A pill-style single choice (radio group) used for presets. */
export function ChoiceChips<T extends string | number>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled,
}: {
  name: string
  legend: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const active = o.value === value
          return (
            <label
              key={String(o.value)}
              className={`cursor-pointer rounded-full border px-4 py-1.5 text-sm font-medium transition focus-within:ring-2 focus-within:ring-ring ${
                active
                  ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                  : 'border-border bg-background text-foreground hover:bg-muted'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={String(o.value)}
                checked={active}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              {o.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** An accessible on/off switch. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>}
      </span>
    </label>
  )
}
