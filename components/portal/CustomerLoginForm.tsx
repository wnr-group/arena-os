'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { sendOtp, verifyOtp } from '@/lib/actions/customer-auth'
import { cn } from '@/lib/utils/cn'

/**
 * Phone → OTP login for the customer portal (AROS-87).
 *
 * Two steps in one component because the second is meaningless without the
 * first: the phone typed in step 1 is the phone verified in step 2, and letting
 * the browser navigate between them would mean trusting it to carry the number
 * across. Nothing secret lives here — the code is checked server-side against a
 * keyed hash, and this component never learns whether the number belongs to an
 * existing customer.
 */
export function CustomerLoginForm({
  venueName,
  devBypassActive,
  redirectTo,
}: {
  venueName: string
  devBypassActive: boolean
  /** Already sanitised server-side by safeCustomerNext(). */
  redirectTo: string
}) {
  const router = useRouter()
  const [step, setStep] = useState<'phone' | 'code' | 'done'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await sendOtp({ phone })
      if (result.error) {
        setError(result.error)
        return
      }
      setCode('')
      setStep('code')
    })
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await verifyOtp({ phone, code, name })
      if (result.error) {
        setError(result.error)
        return
      }
      // The session cookie is already set by the action's Set-Cookie; refresh()
      // discards the router cache so the portal layout re-runs its guard with
      // the new cookie rather than replaying a cached signed-out render.
      setStep('done')
      router.replace(redirectTo)
      router.refresh()
    })
  }

  if (step === 'done') {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">You&rsquo;re signed in</h1>
        <p className="mt-2 text-sm text-muted-foreground">Taking you to your account&hellip;</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{venueName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {step === 'phone'
            ? 'Sign in with your phone number'
            : `Enter the 6-digit code sent to ${phone}`}
        </p>
      </div>

      {devBypassActive && (
        <p
          className="mb-4 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground"
          role="status"
        >
          Development mode — no SMS is sent. Use code <strong>123456</strong>.
        </p>
      )}

      {step === 'phone' ? (
        <form onSubmit={handleSend} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="phone" className="text-sm font-medium">
              Phone number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={pending} className={buttonClass}>
            {pending ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerify} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="code" className="text-sm font-medium">
              Verification code
            </label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className={cn(inputClass, 'text-center text-lg tracking-[0.5em]')}
            />
          </div>

          <div className="space-y-1.5">
            {/* Only used if this phone has never been seen at this venue. Asking
                here rather than up front keeps step 1 from revealing whether the
                number is already on file. */}
            <label htmlFor="name" className="text-sm font-medium">
              Your name <span className="text-muted-foreground">(first time only)</span>
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={pending} className={buttonClass}>
            {pending ? 'Verifying…' : 'Verify and sign in'}
          </button>

          <button
            type="button"
            onClick={() => {
              setStep('phone')
              setError(null)
            }}
            className="w-full text-center text-sm text-muted-foreground hover:underline"
          >
            Use a different number
          </button>
        </form>
      )}
    </div>
  )
}

const inputClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'

const buttonClass = cn(
  'w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground',
  'transition hover:opacity-90 disabled:opacity-50',
)
