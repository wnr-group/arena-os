'use client'

import { useActionState } from 'react'
import { login, type LoginState } from '@/lib/actions/auth'
import { cn } from '@/lib/utils/cn'

const initial: LoginState = {}

/**
 * The sign-in form.
 *
 * Split out of page.tsx so that page can be a SERVER component and turn an
 * already-signed-in visitor away before this ever renders — see the note
 * there. Nothing else about the form changed.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initial)

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>

      {state.error && (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className={cn(
          'w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground',
          'transition hover:opacity-90 disabled:opacity-50',
        )}
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

const inputClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
