'use client'

import { useActionState } from 'react'
import { login, type LoginState } from '@/lib/actions/auth'
import { cn } from '@/lib/utils/cn'

const initial: LoginState = {}

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initial)

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Arena OS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your workspace</p>
        </div>

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
      </div>
    </main>
  )
}

const inputClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
