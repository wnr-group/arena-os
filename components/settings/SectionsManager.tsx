'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  clearAssignments,
  createSection,
  deleteSection,
  handOffServer,
  renameSection,
  setSectionServer,
  setTableSection,
  setTableServer,
} from '@/lib/actions/sections'
import type { SectionConfig, ServerOption } from '@/lib/sections/data'

const field = 'rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring'

function ServerSelect({
  value,
  servers,
  onChange,
  none = 'Unassigned',
  disabled,
}: {
  value: string | null
  servers: ServerOption[]
  onChange: (v: string | null) => void
  none?: string
  disabled?: boolean
}) {
  return (
    <select className={field} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{none}</option>
      {servers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )
}

/** Owner/manager: define sections, put tables in them, and assign servers. */
export function SectionsManager({ branchId, servers, config }: { branchId: string; servers: ServerOption[]; config: SectionConfig }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [newName, setNewName] = useState('')
  const [moveRunning, setMoveRunning] = useState(true)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  function act(fn: () => Promise<{ error?: string }>, done?: string) {
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        if (done) toast.success(done)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-6 space-y-8">
      <section>
        <h2 className="text-base font-semibold">Sections</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Group tables into areas. A section&apos;s server covers all its tables unless a table has its own.
        </p>
        <div className="mt-3 flex gap-2">
          <input className={`${field} flex-1`} placeholder="e.g. Main dining, Patio, Bar" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />
          <button
            disabled={pending || !newName.trim()}
            onClick={() =>
              act(async () => {
                const r = await createSection(branchId, newName)
                if (!r.error) setNewName('')
                return r
              })
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} /> Add
          </button>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={moveRunning} onChange={(e) => setMoveRunning(e.target.checked)} />
          When I change a server, also move the tables they&apos;re running right now
        </label>

        <ul className="mt-3 space-y-2">
          {config.sections.length === 0 && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No sections yet — the floor shows one flat list.</li>}
          {config.sections.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
              <input
                className={`${field} w-44 font-medium`}
                defaultValue={s.name}
                maxLength={60}
                onBlur={(e) => e.target.value.trim() !== s.name && act(() => renameSection(s.id, e.target.value), 'Renamed.')}
              />
              <span className="text-xs text-muted-foreground">{config.tables.filter((t) => t.sectionId === s.id).length} tables</span>
              <span className="flex-1" />
              <ServerSelect value={s.assignedServerId} servers={servers} disabled={pending} onChange={(v) => act(() => setSectionServer(s.id, v, moveRunning))} />
              <button
                aria-label={`Delete ${s.name}`}
                disabled={pending}
                onClick={() => window.confirm(`Delete “${s.name}”? Its tables become unsectioned.`) && act(() => deleteSection(s.id), 'Section deleted.')}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-base font-semibold">Tables</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Table</th>
                <th className="px-3 py-2">Section</th>
                <th className="px-3 py-2">Own server</th>
              </tr>
            </thead>
            <tbody>
              {config.tables.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{t.name}</td>
                  <td className="px-3 py-2">
                    <select className={field} value={t.sectionId ?? ''} disabled={pending} onChange={(e) => act(() => setTableSection(t.id, e.target.value || null))}>
                      <option value="">No section</option>
                      {config.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <ServerSelect value={t.assignedServerId} servers={servers} none="Section's server" disabled={pending} onChange={(v) => act(() => setTableServer(t.id, v, moveRunning))} />
                  </td>
                </tr>
              ))}
              {config.tables.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    No tables yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-base font-semibold">Mid-shift hand-off</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          A server is going home? Move everything they cover — sections, tables and the parties they&apos;re serving — to someone else. Tables whose bill is already requested keep their server.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ServerSelect value={from || null} servers={servers} none="From…" onChange={(v) => setFrom(v ?? '')} />
          <span className="text-muted-foreground">→</span>
          <ServerSelect value={to || null} servers={servers.filter((s) => s.id !== from)} none="To nobody" onChange={(v) => setTo(v ?? '')} />
          <button
            disabled={pending || !from}
            onClick={() =>
              act(async () => {
                const r = await handOffServer(from, to || null)
                if (!r.error && r.data) toast.success(`Moved ${r.data.sections} sections, ${r.data.tables} tables, ${r.data.sessions} running parties.`)
                if (!r.error) setFrom('')
                return r
              })
            }
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Hand off
          </button>
          <span className="flex-1" />
          <button
            disabled={pending}
            onClick={() => window.confirm('Clear every section and table server assignment? Running tables keep their server.') && act(() => clearAssignments(), 'Assignments cleared.')}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Clear all (end of shift)
          </button>
        </div>
      </section>
    </div>
  )
}
