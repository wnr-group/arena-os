'use client'

import { Check } from 'lucide-react'

/** Shared step indicator for both wizards (M21 #3) — filled+checked for a
 *  completed step, ringed for the current one, muted for what's ahead. */
export function StepProgress({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-start" role="list" aria-label={`Step ${current + 1} of ${steps.length}: ${steps[current]}`}>
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={label} role="listitem" className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors duration-300 ${
                  done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : active
                      ? 'border-primary bg-accent text-primary'
                      : 'border-border bg-card text-muted-foreground'
                }`}
              >
                {done ? <Check size={14} /> : i + 1}
              </div>
              <span
                className={`hidden text-center text-xs font-medium sm:block ${
                  active ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`mx-2 mt-4 h-0.5 flex-1 rounded-full transition-colors duration-300 ${
                  done ? 'bg-primary' : 'bg-border'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
