'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Pencil, Trash2, X, ArrowUpRight } from 'lucide-react'
import {
  upsertMenuCategory,
  deleteMenuCategory,
  upsertMenuItem,
  deleteMenuItem,
  uploadMenuItemImage,
} from '@/lib/actions/menu'
import { formatMoney } from '@/lib/format'

type CategoryRow = { id: string; name: string; sortOrder: number; isActive: boolean }
type TaxRateRow = { id: string; name: string; percent: string; isActive: boolean }
type ItemStatus = 'available' | 'out_of_stock' | 'hidden'
type ItemRow = {
  id: string
  name: string
  description: string | null
  price: string
  status: ItemStatus
  imageUrl: string | null
  sortOrder: number
  categoryId: string
  categoryName: string
  taxRateId: string | null
  taxRateName: string | null
}

type Run = (fn: () => Promise<{ error?: string }>) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

const STATUS_LABELS: Record<ItemStatus, string> = {
  available: 'Available',
  out_of_stock: 'Out of stock',
  hidden: 'Hidden',
}

export function MenuManager({
  currency,
  categories,
  taxRates,
  items,
}: {
  currency: string
  categories: CategoryRow[]
  taxRates: TaxRateRow[]
  items: ItemRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const run: Run = (fn) => {
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

      {/* ── categories ── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Categories</h2>
        <div className="mt-3 space-y-2">
          {categories.length === 0 && <p className="text-sm text-muted-foreground">No categories yet. Add one below.</p>}
          {categories.map((c) => (
            <CategoryItem key={c.id} row={c} pending={pending} run={run} />
          ))}
        </div>
        <CategoryForm pending={pending} run={run} />
      </section>

      {/* ── tax rates ── */}
      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tax rates</h2>
          <Link href="/settings/tax-rates" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            Manage tax rates <ArrowUpRight size={14} />
          </Link>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {taxRates.length === 0
            ? 'No tax rates yet.'
            : `${taxRates.length} rate${taxRates.length === 1 ? '' : 's'} configured, used below to tax menu items.`}
        </p>
      </section>

      {/* ── items ── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Items</h2>
        {categories.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Add a category first.</p>
        ) : (
          <>
            <div className="mt-3 space-y-2">
              {items.length === 0 && <p className="text-sm text-muted-foreground">No items yet.</p>}
              {items.map((i) => (
                <ItemItem key={i.id} row={i} categories={categories} taxRates={taxRates} currency={currency} pending={pending} run={run} />
              ))}
            </div>
            <ItemForm categories={categories} taxRates={taxRates} pending={pending} run={run} />
          </>
        )}
      </section>
    </div>
  )
}

// ── category row + form ────────────────────────────────────────────────────
function CategoryItem({ row, pending, run }: { row: CategoryRow; pending: boolean; run: Run }) {
  const [editing, setEditing] = useState(false)
  if (editing) return <CategoryForm row={row} pending={pending} run={run} onDone={() => setEditing(false)} />
  return (
    <div className="flex items-center justify-between rounded-md border px-4 py-3">
      <div>
        <span className="font-medium">{row.name}</span>
        {!row.isActive && <span className="ml-3 text-sm text-muted-foreground">Inactive</span>}
      </div>
      <div className="flex gap-1">
        <button className={btn} onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil size={15} />
        </button>
        <button
          className={`${btn} text-destructive`}
          disabled={pending}
          onClick={() => run(() => deleteMenuCategory(row.id))}
          aria-label="Delete"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

function CategoryForm({ row, pending, run, onDone }: { row?: CategoryRow; pending: boolean; run: Run; onDone?: () => void }) {
  const [name, setName] = useState(row?.name ?? '')
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0))
  const [isActive, setIsActive] = useState(row?.isActive ?? true)

  function submit() {
    run(async () => {
      const r = await upsertMenuCategory({
        id: row?.id,
        name,
        sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
        isActive,
      })
      if (!r.error) {
        if (onDone) onDone()
        else {
          setName('')
          setSortOrder('0')
        }
      }
      return r
    })
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-dashed p-3 sm:grid-cols-4">
      <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={input} placeholder="Sort order" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
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

// ── item row + form ─────────────────────────────────────────────────────────
function ItemItem({
  row,
  categories,
  taxRates,
  currency,
  pending,
  run,
}: {
  row: ItemRow
  categories: CategoryRow[]
  taxRates: TaxRateRow[]
  currency: string
  pending: boolean
  run: Run
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <ItemForm row={row} categories={categories} taxRates={taxRates} pending={pending} run={run} onDone={() => setEditing(false)} />
    )
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-4 py-3">
      <div className="flex items-center gap-3">
        {row.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.imageUrl} alt="" className="h-10 w-10 rounded-md border object-cover" />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-md border border-dashed bg-muted/40" />
        )}
        <div>
          <span className="font-medium">{row.name}</span>
          <span className="ml-3 text-sm text-muted-foreground">
            {formatMoney(row.price, currency)} · {row.categoryName}
            {row.taxRateName ? ` · ${row.taxRateName}` : ''}
            {row.status !== 'available' ? ` · ${STATUS_LABELS[row.status]}` : ''}
          </span>
        </div>
      </div>
      <div className="flex gap-1">
        <button className={btn} onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil size={15} />
        </button>
        <button
          className={`${btn} text-destructive`}
          disabled={pending}
          onClick={() => run(() => deleteMenuItem(row.id))}
          aria-label="Delete"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

function ItemForm({
  row,
  categories,
  taxRates,
  pending,
  run,
  onDone,
}: {
  row?: ItemRow
  categories: CategoryRow[]
  taxRates: TaxRateRow[]
  pending: boolean
  run: Run
  onDone?: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [categoryId, setCategoryId] = useState(row?.categoryId ?? categories[0]?.id ?? '')
  const [price, setPrice] = useState(row?.price ?? '')
  const [taxRateId, setTaxRateId] = useState(row?.taxRateId ?? '')
  const [status, setStatus] = useState<ItemStatus>(row?.status ?? 'available')
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0))
  const [imageUrl, setImageUrl] = useState(row?.imageUrl ?? '')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    const r = await uploadMenuItemImage(fd)
    setUploading(false)
    if (r.error) setUploadError(r.error)
    else if (r.url) setImageUrl(r.url)
  }

  function submit() {
    run(async () => {
      const r = await upsertMenuItem({
        id: row?.id,
        categoryId,
        name,
        description,
        price: price === '' ? 0 : Number(price),
        taxRateId: taxRateId || null,
        status,
        imageUrl,
        sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
      })
      if (!r.error) {
        if (onDone) onDone()
        else {
          setName('')
          setDescription('')
          setPrice('')
          setImageUrl('')
          setSortOrder('0')
        }
      }
      return r
    })
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-dashed p-3">
      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className={input} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input className={input} placeholder="Price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        <select className={input} value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
          <option value="">No tax</option>
          {taxRates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.percent}%)
            </option>
          ))}
        </select>
        <select className={input} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
          <option value="available">Available</option>
          <option value="out_of_stock">Out of stock</option>
          <option value="hidden">Hidden</option>
        </select>
        <input className={input} placeholder="Sort order" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
      </div>
      <textarea
        className={input}
        placeholder="Description (optional)"
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex items-center gap-3">
        {imageUrl && (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="" className="h-14 w-14 rounded-md border object-cover" />
            <button
              type="button"
              className="absolute -right-2 -top-2 rounded-full border bg-background p-0.5"
              onClick={() => setImageUrl('')}
              aria-label="Remove image"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <label className={`${btn} cursor-pointer border ${uploading ? 'opacity-50' : ''}`}>
          {uploading ? 'Uploading…' : imageUrl ? 'Replace image' : 'Upload image'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            disabled={uploading}
            onChange={handleFile}
          />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          className={`${btn} bg-primary text-primary-foreground`}
          disabled={pending || uploading || !name || !categoryId}
          onClick={submit}
        >
          {row ? 'Save' : <span className="inline-flex items-center gap-1"><Plus size={15} /> Add item</span>}
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
