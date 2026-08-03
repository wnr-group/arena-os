'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, X } from 'lucide-react'
import {
  upsertResourceType,
  deleteResourceType,
  upsertResource,
  deleteResource,
} from '@/lib/actions/resources'
import { formatMoney } from '@/lib/format'

type TypeRow = {
  id: string
  name: string
  hourlyRate: string
  bufferMinutes: number
  capacity: number | null
  color: string | null
}
type ResourceRow = {
  id: string
  name: string
  status: string
  resourceTypeId: string
  typeName: string
  rateOverride: string | null
}

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

export function ResourcesManager({
  branchId,
  currency,
  types,
  resources,
}: {
  branchId: string
  currency: string
  types: TypeRow[]
  resources: ResourceRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else router.refresh()
    })
  }

  return (
    <div className="mt-8 space-y-10">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ── resource types ── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Resource types
        </h2>
        <div className="mt-3 space-y-2">
          {types.length === 0 && (
            <p className="text-sm text-muted-foreground">No types yet. Add one below.</p>
          )}
          {types.map((t) => (
            <TypeItem key={t.id} row={t} currency={currency} pending={pending} run={run} />
          ))}
        </div>
        <TypeForm pending={pending} run={run} />
      </section>

      {/* ── resources ── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Resources
        </h2>
        {types.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Add a resource type first.</p>
        ) : (
          <>
            <div className="mt-3 space-y-2">
              {resources.length === 0 && (
                <p className="text-sm text-muted-foreground">No resources yet.</p>
              )}
              {resources.map((r) => (
                <ResourceItem
                  key={r.id}
                  row={r}
                  types={types}
                  currency={currency}
                  branchId={branchId}
                  pending={pending}
                  run={run}
                />
              ))}
            </div>
            <ResourceForm branchId={branchId} types={types} pending={pending} run={run} />
          </>
        )}
      </section>
    </div>
  )
}

// ── resource type row + form ──────────────────────────────────────────────────
function TypeItem({
  row,
  currency,
  pending,
  run,
}: {
  row: TypeRow
  currency: string
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>) => void
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return <TypeForm row={row} pending={pending} run={run} onDone={() => setEditing(false)} />
  }
  return (
    <div className="flex items-center justify-between rounded-md border px-4 py-3">
      <div>
        <span className="font-medium">{row.name}</span>
        <span className="ml-3 text-sm text-muted-foreground">
          {formatMoney(row.hourlyRate, currency)}/hr
          {row.bufferMinutes > 0 && ` · ${row.bufferMinutes}m buffer`}
          {row.capacity ? ` · cap ${row.capacity}` : ''}
        </span>
      </div>
      <div className="flex gap-1">
        <button className={btn} onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil size={15} />
        </button>
        <button
          className={`${btn} text-destructive`}
          disabled={pending}
          onClick={() => run(() => deleteResourceType(row.id))}
          aria-label="Delete"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

function TypeForm({
  row,
  pending,
  run,
  onDone,
}: {
  row?: TypeRow
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>) => void
  onDone?: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [rate, setRate] = useState(row?.hourlyRate ?? '')
  const [buffer, setBuffer] = useState(String(row?.bufferMinutes ?? 0))
  const [capacity, setCapacity] = useState(row?.capacity ? String(row.capacity) : '')

  function submit() {
    run(async () => {
      const r = await upsertResourceType({
        id: row?.id,
        name,
        hourlyRate: rate === '' ? 0 : Number(rate),
        bufferMinutes: buffer === '' ? 0 : Number(buffer),
        capacity: capacity === '' ? undefined : Number(capacity),
      })
      if (!r.error) {
        if (onDone) onDone()
        else {
          setName('')
          setRate('')
          setBuffer('0')
          setCapacity('')
        }
      }
      return r
    })
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-dashed p-3 sm:grid-cols-5">
      <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={input} placeholder="₹/hr" type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
      <input className={input} placeholder="Buffer min" type="number" min="0" value={buffer} onChange={(e) => setBuffer(e.target.value)} />
      <input className={input} placeholder="Capacity" type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      <div className="flex gap-2">
        <button className={`${btn} flex-1 bg-primary text-primary-foreground`} disabled={pending || !name} onClick={submit}>
          {row ? 'Save' : <span className="inline-flex items-center gap-1"><Plus size={15} /> Add</span>}
        </button>
        {onDone && (
          <button className={`${btn} border`} onClick={onDone} aria-label="Cancel">
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── resource row + form ───────────────────────────────────────────────────────
function ResourceItem({
  row,
  types,
  currency,
  branchId,
  pending,
  run,
}: {
  row: ResourceRow
  types: TypeRow[]
  currency: string
  branchId: string
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>) => void
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <ResourceForm
        row={row}
        types={types}
        branchId={branchId}
        pending={pending}
        run={run}
        onDone={() => setEditing(false)}
      />
    )
  }
  return (
    <div className="flex items-center justify-between rounded-md border px-4 py-3">
      <div>
        <span className="font-medium">{row.name}</span>
        <span className="ml-3 text-sm text-muted-foreground">
          {row.typeName}
          {row.rateOverride ? ` · ${formatMoney(row.rateOverride, currency)}/hr` : ''}
          {row.status !== 'available' ? ` · ${row.status}` : ''}
        </span>
      </div>
      <div className="flex gap-1">
        <button className={btn} onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil size={15} />
        </button>
        <button
          className={`${btn} text-destructive`}
          disabled={pending}
          onClick={() => run(() => deleteResource(row.id))}
          aria-label="Delete"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

function ResourceForm({
  row,
  types,
  branchId,
  pending,
  run,
  onDone,
}: {
  row?: ResourceRow
  types: TypeRow[]
  branchId: string
  pending: boolean
  run: (fn: () => Promise<{ error?: string }>) => void
  onDone?: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [typeId, setTypeId] = useState(row?.resourceTypeId ?? types[0]?.id ?? '')
  const [status, setStatus] = useState(row?.status ?? 'available')
  const [override, setOverride] = useState(row?.rateOverride ?? '')

  function submit() {
    run(async () => {
      const r = await upsertResource({
        id: row?.id,
        branchId,
        resourceTypeId: typeId,
        name,
        status: status as 'available' | 'maintenance' | 'inactive',
        hourlyRateOverride: override === '' ? null : Number(override),
      })
      if (!r.error) {
        if (onDone) onDone()
        else {
          setName('')
          setOverride('')
        }
      }
      return r
    })
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-dashed p-3 sm:grid-cols-5">
      <input className={input} placeholder="Name e.g. PS5 #1" value={name} onChange={(e) => setName(e.target.value)} />
      <select className={input} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="available">Available</option>
        <option value="maintenance">Maintenance</option>
        <option value="inactive">Inactive</option>
      </select>
      <input className={input} placeholder="Rate override" type="number" min="0" value={override} onChange={(e) => setOverride(e.target.value)} />
      <div className="flex gap-2">
        <button className={`${btn} flex-1 bg-primary text-primary-foreground`} disabled={pending || !name || !typeId} onClick={submit}>
          {row ? 'Save' : <span className="inline-flex items-center gap-1"><Plus size={15} /> Add</span>}
        </button>
        {onDone && (
          <button className={`${btn} border`} onClick={onDone} aria-label="Cancel">
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
