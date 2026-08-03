'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveWorkingHours } from '@/lib/actions/resources'

type Day = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const input = 'rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring'

export function WorkingHoursForm({ branchId, initialDays }: { branchId: string; initialDays: Day[] }) {
  const router = useRouter()
  const [days, setDays] = useState<Day[]>(initialDays)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function update(dow: number, patch: Partial<Day>) {
    setDays((ds) => ds.map((d) => (d.dayOfWeek === dow ? { ...d, ...patch } : d)))
    setSaved(false)
  }

  function submit() {
    setError(null)
    start(async () => {
      const r = await saveWorkingHours({ branchId, days })
      if (r.error) setError(r.error)
      else {
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-6">
      <div className="space-y-2">
        {days.map((d) => (
          <div key={d.dayOfWeek} className="flex items-center gap-3 rounded-md border px-4 py-2.5">
            <span className="w-24 text-sm font-medium">{DOW[d.dayOfWeek]}</span>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={d.isClosed}
                onChange={(e) => update(d.dayOfWeek, { isClosed: e.target.checked })}
              />
              Closed
            </label>
            {!d.isClosed && (
              <div className="ml-auto flex items-center gap-2">
                <input
                  type="time"
                  className={input}
                  value={d.openTime}
                  onChange={(e) => update(d.dayOfWeek, { openTime: e.target.value })}
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="time"
                  className={input}
                  value={d.closeTime}
                  onChange={(e) => update(d.dayOfWeek, { closeTime: e.target.value })}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save hours'}
        </button>
        {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </div>
  )
}
