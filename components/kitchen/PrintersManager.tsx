'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Copy, Loader2, Plus, Printer as PrinterIcon, RefreshCw, Trash2 } from 'lucide-react'
import {
  assignStationPrinter,
  cancelPrintJob,
  createPrinter,
  deletePrinter,
  retryPrintJob,
  rotatePrinterSecret,
  sendTestPrint,
  updatePrinter,
} from '@/lib/actions/printing'
import { usePolling } from './usePolling'

export type PrinterView = {
  id: string
  name: string
  kind: 'kitchen' | 'receipt'
  isDefault: boolean
  isActive: boolean
  paperChars: number
  mediaType: string
  lastSeenAt: string | null
  lastStatus: string | null
}
export type StationView = { id: string; name: string; printerId: string | null }
export type JobView = {
  id: string
  printerName: string
  kind: string
  title: string
  status: string
  error: string | null
  createdAt: string
  kotId: string | null
  invoiceId: string | null
  problem: 'failed' | 'unconfirmed' | 'stuck' | null
}

const field = 'rounded-md border border-border bg-background px-2 py-1.5 text-sm'
const OFFLINE_MS = 2 * 60_000

const PROBLEM_TEXT = {
  failed: 'Failed',
  unconfirmed: 'Not confirmed by printer',
  stuck: 'Not picked up',
} as const

export function PrintersManager({
  printers,
  stations,
  jobs,
  canSetup,
  serverNow,
}: {
  printers: PrinterView[]
  stations: StationView[]
  jobs: JobView[]
  canSetup: boolean
  serverNow: string
}) {
  const router = useRouter()
  usePolling(5000)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ name: string; path: string } | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'kitchen' | 'receipt'>('kitchen')
  const [chars, setChars] = useState('42')
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

  const kitchen = printers.filter((p) => p.kind === 'kitchen' && p.isActive)
  const now = new Date(serverNow).getTime()
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="mt-6 space-y-8">
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {reveal && (
        <div className="rounded-lg border border-amber-500 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold">Server URL for {reveal.name} — copy it now, it is shown only once.</p>
          <p className="mt-1 text-muted-foreground">
            In the printer&apos;s CloudPRNT settings, enable CloudPRNT and paste this as the Server URL. Printers must be in ESC/POS mode.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5">{origin + reveal.path}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(origin + reveal.path)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-medium"
            >
              <Copy size={14} /> Copy
            </button>
            <button type="button" onClick={() => setReveal(null)} className="rounded-md px-2.5 py-1.5 font-medium hover:bg-muted">
              Done
            </button>
          </div>
        </div>
      )}

      <section>
        <h2 className="text-base font-semibold">Printers</h2>
        <ul className="mt-2 divide-y rounded-lg border">
          {printers.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">
              No printers yet. Without one, tickets and bills use browser printing exactly as before.
            </li>
          )}
          {printers.map((p) => {
            const online = p.lastSeenAt && now - new Date(p.lastSeenAt).getTime() < OFFLINE_MS
            return (
              <li key={p.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PrinterIcon size={16} className="text-muted-foreground" />
                  <span className="font-medium">{p.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{p.kind}</span>
                  {p.isDefault && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">default</span>}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${online ? 'bg-emerald-500/10 text-emerald-700' : 'bg-red-500/10 text-red-700'}`}>
                    {online ? 'online' : p.lastSeenAt ? 'offline' : 'never connected'}
                  </span>
                  {p.lastStatus && <span className="text-xs text-muted-foreground">status {p.lastStatus}</span>}
                </div>
                {canSetup && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={p.isActive}
                        onChange={(e) => run(`ac:${p.id}`, () => updatePrinter(p.id, { isActive: e.target.checked }))}
                      />
                      Active
                    </label>
                    {!p.isDefault && p.isActive && (
                      <button type="button" className="font-medium text-primary hover:underline" onClick={() => run(`df:${p.id}`, () => updatePrinter(p.id, { isDefault: true }))}>
                        Make default
                      </button>
                    )}
                    <label className="inline-flex items-center gap-1.5">
                      Width
                      <select
                        className={field}
                        value={p.paperChars}
                        onChange={(e) => run(`w:${p.id}`, () => updatePrinter(p.id, { paperChars: Number(e.target.value) }))}
                      >
                        <option value={32}>58mm (32)</option>
                        <option value={42}>80mm (42)</option>
                        <option value={48}>80mm (48)</option>
                      </select>
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                      Media type
                      <input
                        className={`${field} w-64`}
                        defaultValue={p.mediaType}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v && v !== p.mediaType) run(`m:${p.id}`, () => updatePrinter(p.id, { mediaType: v }))
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 font-medium hover:bg-muted"
                      onClick={() => run(`t:${p.id}`, () => sendTestPrint(p.id))}
                    >
                      {busy === `t:${p.id}` ? <Loader2 size={14} className="animate-spin" /> : <PrinterIcon size={14} />} Test print
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 font-medium hover:bg-muted"
                      onClick={() => {
                        if (confirm(`Generate a new URL for ${p.name}? The printer stops printing until you enter it.`)) {
                          start(async () => {
                            const r = await rotatePrinterSecret(p.id)
                            if (r.error) setError(r.error)
                            else if (r.path) setReveal({ name: p.name, path: r.path })
                            router.refresh()
                          })
                        }
                      }}
                    >
                      <RefreshCw size={14} /> New URL
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${p.name}`}
                      className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        if (confirm(`Delete ${p.name}? Its queued jobs are discarded.`)) run(`d:${p.id}`, () => deletePrinter(p.id))
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {canSetup && (
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              start(async () => {
                setError(null)
                setBusy('new')
                const r = await createPrinter({ name, kind, paperChars: Number(chars) })
                if (r.error) setError(r.error)
                else if (r.path) {
                  setReveal({ name, path: r.path })
                  setName('')
                  router.refresh()
                }
                setBusy(null)
              })
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Grill printer" className={`${field} w-52`} />
            <select value={kind} onChange={(e) => setKind(e.target.value as 'kitchen' | 'receipt')} className={field}>
              <option value="kitchen">Kitchen tickets</option>
              <option value="receipt">Receipts / bills</option>
            </select>
            <select value={chars} onChange={(e) => setChars(e.target.value)} className={field}>
              <option value="32">58mm</option>
              <option value="42">80mm</option>
              <option value="48">80mm (wide)</option>
            </select>
            <button type="submit" disabled={busy === 'new'} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {busy === 'new' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add printer
            </button>
          </form>
        )}
      </section>

      {stations.length > 0 && (
        <section>
          <h2 className="text-base font-semibold">Station → kitchen printer</h2>
          <p className="text-sm text-muted-foreground">Stations without a printer print on the default kitchen printer.</p>
          <ul className="mt-2 divide-y rounded-lg border">
            {stations.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>{s.name}</span>
                <select
                  aria-label={`Printer for ${s.name}`}
                  disabled={!canSetup || busy === `st:${s.id}`}
                  className={field}
                  value={s.printerId ?? ''}
                  onChange={(e) => run(`st:${s.id}`, () => assignStationPrinter(s.id, e.target.value || null))}
                >
                  <option value="">Default kitchen printer</option>
                  {kitchen.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-base font-semibold">Print queue</h2>
        <ul className="mt-2 divide-y rounded-lg border">
          {jobs.length === 0 && <li className="p-3 text-sm text-muted-foreground">Nothing printed in the last 24 hours.</li>}
          {jobs.map((j) => (
            <li key={j.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${j.problem ? 'bg-red-500/5' : ''}`}>
              <span className="font-medium">{j.title}</span>
              <span className="text-muted-foreground">→ {j.printerName}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${j.problem ? 'bg-red-500/10 text-red-700' : j.status === 'printed' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted'}`}>
                {j.problem ? PROBLEM_TEXT[j.problem] : j.status}
              </span>
              {j.error && <span className="text-xs text-red-700">{j.error}</span>}
              <span className="ml-auto flex items-center gap-2">
                {j.problem && j.kotId && (
                  <Link href={`/kitchen/${j.kotId}/print`} className="font-medium text-primary hover:underline">
                    Print in browser
                  </Link>
                )}
                {j.problem && j.invoiceId && (
                  <Link href={`/invoices/${j.invoiceId}`} className="font-medium text-primary hover:underline">
                    Open invoice
                  </Link>
                )}
                {(j.problem || j.status === 'pending') && (
                  <>
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => run(`r:${j.id}`, () => retryPrintJob(j.id))}>
                      Retry
                    </button>
                    <button type="button" className="font-medium text-muted-foreground hover:underline" onClick={() => run(`c:${j.id}`, () => cancelPrintJob(j.id))}>
                      Dismiss
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Link href="/kitchen" className="inline-block text-sm font-medium text-primary hover:underline">
        ← Back to kitchen
      </Link>
    </div>
  )
}
