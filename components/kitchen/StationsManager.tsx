'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { assignStation, createStation, deleteStation, renameStation, setStationActive } from '@/lib/actions/stations'

type Station = { id: string; name: string; isActive: boolean }
type Category = { id: string; name: string; stationId: string | null }
type Item = { id: string; name: string; categoryId: string; stationId: string | null }

const field = 'rounded-md border border-border bg-background px-2 py-1.5 text-sm'

export function StationsManager({ stations, categories, items }: { stations: Station[]; categories: Category[]; items: Item[] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [, start] = useTransition()

  function run(key: string, fn: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null)
    setBusy(key)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        after?.()
        router.refresh()
      }
      setBusy(null)
    })
  }

  const active = stations.filter((s) => s.isActive)
  const stationSelect = (value: string | null, onChange: (v: string | null) => void, blank: string, key: string) => (
    <select
      aria-label={key}
      className={field}
      value={value ?? ''}
      disabled={busy === key}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{blank}</option>
      {active.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )

  return (
    <div className="mt-6 space-y-8">
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section>
        <h2 className="text-base font-semibold">Stations</h2>
        <ul className="mt-2 divide-y rounded-lg border">
          {stations.length === 0 && <li className="p-3 text-sm text-muted-foreground">No stations yet — add Bar, Grill, Fryer…</li>}
          {stations.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 p-3">
              <input
                defaultValue={s.name}
                aria-label={`Name of ${s.name}`}
                className={`${field} w-48`}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== s.name) run(`rn:${s.id}`, () => renameStation(s.id, v))
                }}
              />
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={s.isActive}
                  onChange={(e) => run(`ac:${s.id}`, () => setStationActive(s.id, e.target.checked))}
                />
                Active
              </label>
              <button
                type="button"
                aria-label={`Delete ${s.name}`}
                onClick={() => {
                  if (confirm(`Delete ${s.name}? Dishes sent there become unrouted.`)) run(`del:${s.id}`, () => deleteStation(s.id))
                }}
                className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                {busy === `del:${s.id}` ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) run('new', () => createStation(name), () => setName(''))
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New station, e.g. Grill" className={`${field} w-56`} />
          <button
            type="submit"
            disabled={busy === 'new'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === 'new' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-base font-semibold">Menu routing</h2>
        <p className="text-sm text-muted-foreground">Set a category&apos;s station, then override single dishes only where they differ.</p>
        <div className="mt-2 space-y-4">
          {categories.map((c) => {
            const catItems = items.filter((i) => i.categoryId === c.id)
            return (
              <div key={c.id} className="rounded-lg border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 p-3">
                  <span className="font-medium">{c.name}</span>
                  {stationSelect(
                    c.stationId,
                    (v) => run(`cat:${c.id}`, () => assignStation({ kind: 'category', id: c.id }, v)),
                    'No station',
                    `cat:${c.id}`,
                  )}
                </div>
                <ul className="divide-y">
                  {catItems.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span>{i.name}</span>
                      {stationSelect(
                        i.stationId,
                        (v) => run(`item:${i.id}`, () => assignStation({ kind: 'item', id: i.id }, v)),
                        'Same as category',
                        `item:${i.id}`,
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </section>

      <Link href="/kitchen" className="inline-block text-sm font-medium text-primary hover:underline">
        ← Back to kitchen
      </Link>
    </div>
  )
}
