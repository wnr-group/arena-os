import Link from 'next/link'
import { ArrowRight, Check, Circle } from 'lucide-react'
import type { OnboardingProgress } from '@/lib/onboarding/checklist'
import { cn } from '@/lib/utils/cn'

/**
 * The new-workspace setup panel on the dashboard (M16 #6).
 *
 * A server component — every step is a link and a tick, so none of this needs
 * to reach the browser as JavaScript.
 *
 * It renders nothing at all once every step is done. There is no dismiss
 * control and no stored "hidden" flag on purpose: the panel's own completion IS
 * the dismissal, so there is no state to persist and no way for a workspace to
 * be told it is set up when it is not.
 */
export function OnboardingChecklist({ progress }: { progress: OnboardingProgress }) {
  if (progress.allDone || progress.steps.length === 0) return null

  const pct = Math.round((progress.completed / progress.total) * 100)
  // The first thing still outstanding — what the big button points at, so the
  // owner has one obvious next action rather than eight equal ones.
  const next = progress.steps.find((s) => !s.done)

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">Finish setting up</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {progress.completed} of {progress.total} done — you can use Arena OS while you work
            through these.
          </p>
        </div>

        {next && (
          <Link
            href={next.href}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {next.title}
            <ArrowRight size={14} aria-hidden />
          </Link>
        )}
      </div>

      <div className="px-5 pt-4">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Setup progress"
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ul className="divide-y divide-border px-5 py-2">
        {progress.steps.map((step) => (
          <li key={step.key}>
            <Link
              href={step.href}
              className="group flex items-start gap-3 py-3 transition hover:opacity-90"
            >
              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                  step.done
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-border text-muted-foreground',
                )}
                aria-hidden
              >
                {step.done ? <Check size={12} strokeWidth={3} /> : <Circle size={6} fill="currentColor" />}
              </span>

              <span className="min-w-0">
                <span
                  className={cn(
                    'block text-sm font-medium',
                    step.done ? 'text-muted-foreground line-through' : 'group-hover:text-primary',
                  )}
                >
                  {step.title}
                </span>
                {!step.done && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{step.description}</span>
                )}
              </span>

              <span className="sr-only">{step.done ? 'Done' : 'Not done yet'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
