'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Settings2 } from 'lucide-react'
import { saveKdsSettings } from '@/lib/actions/kds'

/** Manager/owner control for the kitchen display: opt-in switch + the minutes
 *  at which a ticket's timer turns amber ("slow") and red ("late"). */
export function KdsSettings({
  enabled,
  warnMinutes,
  lateMinutes,
  coursesEnabled,
  courseNames,
}: {
  enabled: boolean
  warnMinutes: number
  lateMinutes: number
  coursesEnabled: boolean
  courseNames: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [on, setOn] = useState(enabled)
  const [warn, setWarn] = useState(String(warnMinutes))
  const [late, setLate] = useState(String(lateMinutes))
  const [courses, setCourses] = useState(coursesEnabled)
  const [names, setNames] = useState(courseNames.join(', '))
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function save() {
    setError(null)
    startTransition(async () => {
      const r = await saveKdsSettings({ enabled: on, warnMinutes: Number(warn),
        lateMinutes: Number(late),
        coursesEnabled: courses,
        courseNames: names.split(',').map((n) => n.trim()).filter(Boolean),
      })
      if (r.error) setError(r.error)
      else {
        setOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <Settings2 size={15} /> Kitchen display settings {enabled ? '· on' : '· off'}
      </button>
      {open && (
        <div className="mt-2 max-w-md space-y-3 rounded-xl border border-border bg-card p-4">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-1 size-4" />
            <span>
              <span className="font-medium">Use the kitchen display</span>
              <span className="block text-muted-foreground">
                Per-item bump, timers and all-day counts. Off keeps the simple ticket list.
              </span>
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="font-medium">Slow after (min)</span>
              <input type="number" min={1} value={warn} onChange={(e) => setWarn(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5" />
            </label>
            <label className="text-sm">
              <span className="font-medium">Late after (min)</span>
              <input type="number" min={2} value={late} onChange={(e) => setLate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5" />
            </label>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={courses} onChange={(e) => setCourses(e.target.checked)} className="mt-1 size-4" />
            <span>
              <span className="font-medium">Course firing</span>
              <span className="block text-muted-foreground">
                Waiters can hold later courses and fire them when the table is ready. Needs the kitchen display on.
              </span>
            </span>
          </label>
          {courses && (
            <label className="block text-sm">
              <span className="font-medium">Course names, in order (comma-separated)</span>
              <input value={names} onChange={(e) => setNames(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5" />
            </label>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending && <Loader2 size={14} className="animate-spin" />} Save
          </button>
        </div>
      )}
    </div>
  )
}
