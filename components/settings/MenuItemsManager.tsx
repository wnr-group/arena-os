'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Pencil, Trash2, X, UtensilsCrossed, CheckCircle2, PackageX, EyeOff } from 'lucide-react'
import { upsertMenuItem, deleteMenuItem, uploadMenuItemImage } from '@/lib/actions/menu'
import { formatMoney } from '@/lib/format'

type CategoryRow = { id: string; name: string; isActive: boolean }
type TaxRateRow = { id: string; name: string; percent: string }
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
type Modal = { mode: 'add' } | { mode: 'edit'; row: ItemRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

const STATUS_LABELS: Record<ItemStatus, string> = {
  available: 'Available',
  out_of_stock: 'Out of stock',
  hidden: 'Hidden',
}
const STATUS_BADGE: Record<ItemStatus, string> = {
  available: 'bg-emerald-500/10 text-emerald-600',
  out_of_stock: 'bg-amber-500/10 text-amber-600',
  hidden: 'bg-muted text-muted-foreground',
}

export function MenuItemsManager({
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
  const [modal, setModal] = useState<Modal | null>(null)

  const run: Run = (fn, onSuccess) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        router.refresh()
        onSuccess?.()
      }
    })
  }

  const stats = useMemo(() => {
    const total = items.length
    const available = items.filter((i) => i.status === 'available').length
    const outOfStock = items.filter((i) => i.status === 'out_of_stock').length
    const hidden = items.filter((i) => i.status === 'hidden').length
    return { total, available, outOfStock, hidden }
  }, [items])

  function handleDelete(row: ItemRow) {
    if (!window.confirm(`Delete item "${row.name}"? This cannot be undone.`)) return
    run(() => deleteMenuItem(row.id))
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={UtensilsCrossed} label="Total items" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="Available" value={stats.available} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={PackageX} label="Out of stock" value={stats.outOfStock} accent="bg-amber-500/10 text-amber-600" />
        <StatCard icon={EyeOff} label="Hidden" value={stats.hidden} accent="bg-muted text-muted-foreground" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All items</h2>
        {categories.length > 0 && (
          <button
            className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
            onClick={() => setModal({ mode: 'add' })}
          >
            <Plus size={15} /> Add item
          </button>
        )}
      </div>

      {categories.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Add a{' '}
          <Link href="/menu/categories" className="font-medium text-primary hover:underline">
            menu category
          </Link>{' '}
          first before adding items.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Tax</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No items yet. Add one to get started.
                    </td>
                  </tr>
                )}
                {items.map((row) => (
                  <tr key={row.id} className="transition hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {row.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={row.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-md border object-cover" />
                        ) : (
                          <div className="h-10 w-10 shrink-0 rounded-md border border-dashed bg-muted/40" />
                        )}
                        <span className="font-medium">{row.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.categoryName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatMoney(row.price, currency)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.taxRateName ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[row.status]}`}>
                        {STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button className={btn} onClick={() => setModal({ mode: 'edit', row })} aria-label="Edit">
                          <Pencil size={15} />
                        </button>
                        <button
                          className={`${btn} text-destructive`}
                          disabled={pending}
                          onClick={() => handleDelete(row)}
                          aria-label="Delete"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <ItemModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          categories={categories}
          taxRates={taxRates}
          pending={pending}
          run={run}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string | number
  accent: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function ItemModal({
  row,
  categories,
  taxRates,
  pending,
  run,
  onClose,
}: {
  row?: ItemRow
  categories: CategoryRow[]
  taxRates: TaxRateRow[]
  pending: boolean
  run: Run
  onClose: () => void
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
    run(
      () =>
        upsertMenuItem({
          id: row?.id,
          categoryId,
          name,
          description,
          price: price === '' ? 0 : Number(price),
          taxRateId: taxRateId || null,
          status,
          imageUrl,
          sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
        }),
      onClose,
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{row ? 'Edit item' : 'Add item'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <select className={input} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Price</label>
              <input
                className={input}
                placeholder="0.00"
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Tax rate</label>
              <select className={input} value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
                <option value="">No tax</option>
                {taxRates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.percent}%)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <select className={input} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
                <option value="available">Available</option>
                <option value="out_of_stock">Out of stock</option>
                <option value="hidden">Hidden</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Sort order</label>
            <input className={input} type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
            <textarea
              className={input}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Image</label>
            <div className="mt-1 flex items-center gap-3">
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
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className={`${btn} flex-1 bg-primary text-primary-foreground`}
            disabled={pending || uploading || !name || !categoryId}
            onClick={submit}
          >
            {row ? 'Save changes' : 'Add item'}
          </button>
          <button className={`${btn} border`} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
