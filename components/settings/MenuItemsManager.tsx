'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Plus,
  Pencil,
  Trash2,
  X,
  UtensilsCrossed,
  CheckCircle2,
  PackageX,
  EyeOff,
  LayoutGrid,
  Table2,
  Percent,
  Search,
  Filter,
  ChevronDown,
  Loader2,
  UploadCloud,
  FileImage,
} from 'lucide-react'
import { upsertMenuItem, deleteMenuItem, uploadMenuItemImage } from '@/lib/actions/menu'
import { formatMoney } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'

function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(url.split('/').pop() || url)
  } catch {
    return url
  }
}

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
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void, onSettled?: () => void) => void
type View = 'table' | 'grid'

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'
const NAME_PATTERN = /^[\p{L}\p{N} &'.,()-]+$/u
const DESCRIPTION_PATTERN = /^[\p{L}\p{N}\s&'".,()!?/-]+$/u

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
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [view, setView] = useState<View>('grid')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ItemStatus>('all')

  const run: Run = (fn, onSuccess, onSettled) => {
    start(async () => {
      const r = await fn()
      if (r.error) {
        toast.error(r.error)
      } else {
        router.refresh()
        onSuccess?.()
      }
      onSettled?.()
    })
  }

  const stats = useMemo(() => {
    const total = items.length
    const available = items.filter((i) => i.status === 'available').length
    const outOfStock = items.filter((i) => i.status === 'out_of_stock').length
    const hidden = items.filter((i) => i.status === 'hidden').length
    return { total, available, outOfStock, hidden }
  }, [items])

  // Inactive categories are retired — don't offer them as a filter, even if
  // existing items still reference one (those stay visible under "All
  // categories", they just don't get their own tab).
  const filterableCategories = useMemo(() => categories.filter((c) => c.isActive), [categories])

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((row) => {
      if (categoryFilter !== 'all' && row.categoryId !== categoryFilter) return false
      if (statusFilter !== 'all' && row.status !== statusFilter) return false
      if (q && !row.name.toLowerCase().includes(q) && !(row.description ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, categoryFilter, statusFilter])

  const filtersActive = search.trim() !== '' || categoryFilter !== 'all' || statusFilter !== 'all'

  function resetFilters() {
    setSearch('')
    setCategoryFilter('all')
    setStatusFilter('all')
  }

  async function handleDelete(row: ItemRow) {
    await confirm({
      title: `Delete item "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteMenuItem(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          router.refresh()
          toast.success(`Item "${row.name}" deleted.`)
        }
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={UtensilsCrossed} label="Total items" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="Available" value={stats.available} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={PackageX} label="Out of stock" value={stats.outOfStock} accent="bg-amber-500/10 text-amber-600" />
        <StatCard icon={EyeOff} label="Hidden" value={stats.hidden} accent="bg-muted text-muted-foreground" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
          All items {items.length > 0 && <span className="text-muted-foreground/60">({filteredItems.length})</span>}
        </h2>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-1">
            <button
              type="button"
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium uppercase tracking-wide transition ${
                view === 'grid' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('grid')}
              aria-pressed={view === 'grid'}
            >
              <LayoutGrid size={15} /> Grid
            </button>
            <button
              type="button"
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium uppercase tracking-wide transition ${
                view === 'table' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('table')}
              aria-pressed={view === 'table'}
            >
              <Table2 size={15} /> Table
            </button>
          </div>
          {categories.length > 0 && (
            <button
              className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
              onClick={() => setModal({ mode: 'add' })}
            >
              <Plus size={16} /> Add Item
            </button>
          )}
        </div>
      </div>

      {categories.length > 0 && items.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card/50 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
              <input
                className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                placeholder="Search items by name or description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="relative">
              <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <select
                className="appearance-none rounded-lg border border-border bg-background py-2.5 pl-9 pr-9 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | ItemStatus)}
              >
                <option value="all">All statuses</option>
                <option value="available">Available</option>
                <option value="out_of_stock">Out of stock</option>
                <option value="hidden">Hidden</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
            </div>

            {filtersActive && (
              <button type="button" onClick={resetFilters} className="text-sm font-medium uppercase tracking-wide text-primary hover:underline">
                Clear Filters
              </button>
            )}
          </div>

          <div className="flex gap-1 overflow-x-auto border-t border-border px-2">
            <CategoryTab active={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>
              All Categories
            </CategoryTab>
            {filterableCategories.map((c) => (
              <CategoryTab key={c.id} active={categoryFilter === c.id} onClick={() => setCategoryFilter(c.id)}>
                {c.name}
              </CategoryTab>
            ))}
          </div>
        </div>
      )}

      {categories.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Add a{' '}
          <Link href="/menu/categories" className="font-medium text-primary hover:underline">
            menu category
          </Link>{' '}
          first before adding items.
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-base text-muted-foreground">
          No items yet. Add one to get started.
        </p>
      ) : filteredItems.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-base text-muted-foreground">
          No items match your filters.{' '}
          <button type="button" onClick={resetFilters} className="font-medium uppercase tracking-wide text-primary hover:underline">
            Clear Filters
          </button>
        </p>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredItems.map((row) => (
            <ItemCard
              key={row.id}
              row={row}
              currency={currency}
              pending={pending}
              deleting={deletingId === row.id}
              onEdit={() => setModal({ mode: 'edit', row })}
              onDelete={() => handleDelete(row)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-base">
              <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
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
                {filteredItems.map((row) => (
                  <tr key={row.id} className="transition hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {row.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={row.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded-md border object-cover" />
                        ) : (
                          <div className="h-11 w-11 shrink-0 rounded-md border border-dashed bg-muted/40" />
                        )}
                        <span className="font-medium">{row.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.categoryName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatMoney(row.price, currency)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.taxRateName ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${STATUS_BADGE[row.status]}`}>
                        {STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          className={btn}
                          disabled={pending}
                          onClick={() => setModal({ mode: 'edit', row })}
                          aria-label="Edit"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className={`${btn} text-destructive`}
                          disabled={pending}
                          onClick={() => handleDelete(row)}
                          aria-label="Delete"
                        >
                          {deletingId === row.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
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
          currency={currency}
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
    <div className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110 ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function CategoryTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative shrink-0 whitespace-nowrap px-4 py-3 text-sm font-medium uppercase tracking-wide transition ${
        active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
      <span
        className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full transition ${active ? 'bg-primary' : 'bg-transparent'}`}
      />
    </button>
  )
}

/** Image/placeholder block with a status badge, shared by the grid card and the modal's live preview. */
function ItemVisual({ imageUrl, status }: { imageUrl?: string | null; status: ItemStatus }) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-muted/70 to-muted/20">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
          <UtensilsCrossed size={30} />
        </div>
      )}
      <span
        className={`absolute left-2 top-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur-sm ${STATUS_BADGE[status]}`}
      >
        {STATUS_LABELS[status]}
      </span>
    </div>
  )
}

/** Name/price/category/description block, shared by the grid card and the modal's live preview. */
function ItemCardBody({
  name,
  categoryName,
  price,
  currency,
  description,
  taxLabel,
}: {
  name: string
  categoryName?: string | null
  price: number | string
  currency: string
  description?: string | null
  taxLabel?: string | null
}) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 text-base font-semibold">{name || 'Untitled item'}</h3>
        <span className="shrink-0 text-base font-semibold text-primary">{formatMoney(price, currency)}</span>
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">{categoryName || 'No category'}</p>
      {description && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground/80">{description}</p>}
      {taxLabel && (
        <p className="mt-2.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Percent size={12} /> {taxLabel}
        </p>
      )}
    </div>
  )
}

function ItemCard({
  row,
  currency,
  pending,
  deleting,
  onEdit,
  onDelete,
}: {
  row: ItemRow
  currency: string
  pending: boolean
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg">
      <ItemVisual imageUrl={row.imageUrl} status={row.status} />
      <div
        className={`absolute right-2 top-2 flex gap-1 transition ${
          deleting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          type="button"
          className="rounded-md border border-border/60 bg-background/90 p-1.5 text-foreground shadow-sm backdrop-blur-sm hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onEdit}
          aria-label="Edit"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="rounded-md border border-border/60 bg-background/90 p-1.5 text-destructive shadow-sm backdrop-blur-sm hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onDelete}
          aria-label="Delete"
        >
          {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
      </div>
      <ItemCardBody
        name={row.name}
        categoryName={row.categoryName}
        price={row.price}
        currency={currency}
        description={row.description}
        taxLabel={row.taxRateName}
      />
    </div>
  )
}

function ItemModal({
  row,
  categories,
  taxRates,
  currency,
  pending,
  run,
  onClose,
}: {
  row?: ItemRow
  categories: CategoryRow[]
  taxRates: TaxRateRow[]
  currency: string
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [categoryId, setCategoryId] = useState(row?.categoryId ?? categories.find((c) => c.isActive)?.id ?? '')
  const [price, setPrice] = useState(row?.price ?? '')
  const [taxRateId, setTaxRateId] = useState(row?.taxRateId ?? '')
  const [status, setStatus] = useState<ItemStatus>(row?.status ?? 'available')
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0))
  const [imageUrl, setImageUrl] = useState(row?.imageUrl ?? '')
  const [fileName, setFileName] = useState<string | null>(row?.imageUrl ? fileNameFromUrl(row.imageUrl) : null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const previewCategoryName = categories.find((c) => c.id === categoryId)?.name
  const selectedTax = taxRates.find((t) => t.id === taxRateId)
  const previewTaxLabel = selectedTax ? `${selectedTax.name} · ${selectedTax.percent}%` : null
  // Retired categories can't be picked for new/other items, but stay in the
  // list if this item is currently in one — otherwise the select would
  // silently reassign it on save.
  const selectableCategories = categories.filter((c) => c.isActive || c.id === categoryId)

  const errors = useMemo(() => {
    const e: { name?: string; description?: string; categoryId?: string; price?: string; sortOrder?: string } = {}
    const trimmedName = name.trim()
    if (!trimmedName) e.name = 'Name is required.'
    else if (trimmedName.length < 2) e.name = 'Name must be at least 2 characters.'
    else if (trimmedName.length > 100) e.name = 'Name must be at most 100 characters.'
    else if (!NAME_PATTERN.test(trimmedName))
      e.name = "Name can only contain letters, numbers, spaces, and & - ' . , ( )"
    const trimmedDescription = description.trim()
    if (trimmedDescription) {
      if (trimmedDescription.length < 5) e.description = 'Description must be at least 5 characters.'
      else if (trimmedDescription.length > 500) e.description = 'Description must be at most 500 characters.'
      else if (!DESCRIPTION_PATTERN.test(trimmedDescription))
        e.description = "Description contains characters that aren't allowed."
    }
    if (!categoryId) e.categoryId = 'Select a category.'
    if (price === '') e.price = 'Price is required.'
    else if (Number.isNaN(Number(price))) e.price = 'Enter a valid price.'
    else if (Number(price) < 0) e.price = "Price can't be negative."
    if (sortOrder !== '' && (Number.isNaN(Number(sortOrder)) || !Number.isInteger(Number(sortOrder))))
      e.sortOrder = 'Sort order must be a whole number.'
    return e
  }, [name, description, categoryId, price, sortOrder])
  const isValid = Object.keys(errors).length === 0

  useBodyScrollLock()

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
    else if (r.url) {
      setImageUrl(r.url)
      setFileName(file.name)
    }
  }

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () =>
        upsertMenuItem({
          id: row?.id,
          categoryId,
          name: name.trim(),
          description,
          price: Number(price),
          taxRateId: taxRateId || null,
          status,
          imageUrl,
          sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
        }),
      () => {
        toast.success(row ? `Item "${name.trim()}" updated.` : `Item "${name.trim()}" added.`)
        onClose()
      },
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative grid max-h-[92vh] w-full max-w-4xl grid-cols-1 overflow-y-auto rounded-xl border border-border bg-card shadow-2xl md:grid-cols-[1.3fr_1fr]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full border border-border/60 bg-background/90 p-1.5 text-muted-foreground shadow-sm backdrop-blur-sm transition hover:text-foreground"
        >
          <X size={16} />
        </button>

        {/* Form */}
        <div className="order-2 p-6 pt-8 md:order-1">
          <h2 className="text-xl font-semibold">{row ? 'Edit item' : 'Add item'}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Fill in the details — the preview updates as you type.</p>

          <div className="mt-4 space-y-3">
            {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
            <div>
              <label className={label}>
                Name <span className="text-destructive">*</span>
              </label>
              <input
                className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
                placeholder="e.g. Margherita Pizza"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                autoFocus
              />
              {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>
                  Category <span className="text-destructive">*</span>
                </label>
                <select
                  className={`${input} ${submitted && errors.categoryId ? inputInvalid : ''}`}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  {selectableCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {!c.isActive ? ' (inactive)' : ''}
                    </option>
                  ))}
                </select>
                {submitted && errors.categoryId && <p className={errorText}>{errors.categoryId}</p>}
              </div>
              <div>
                <label className={label}>
                  Price <span className="text-destructive">*</span>
                </label>
                <input
                  className={`${input} ${submitted && errors.price ? inputInvalid : ''}`}
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
                {submitted && errors.price && <p className={errorText}>{errors.price}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Tax rate</label>
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
                <label className={label}>Status</label>
                <select className={input} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
                  <option value="available">Available</option>
                  <option value="out_of_stock">Out of stock</option>
                  <option value="hidden">Hidden</option>
                </select>
              </div>
            </div>
            <div>
              <label className={label}>Sort order</label>
              <input
                className={`${input} ${submitted && errors.sortOrder ? inputInvalid : ''}`}
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
              {submitted && errors.sortOrder && <p className={errorText}>{errors.sortOrder}</p>}
            </div>
            <div>
              <label className={label}>Description (optional)</label>
              <textarea
                className={`${input} ${submitted && errors.description ? inputInvalid : ''}`}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
              {submitted && errors.description && <p className={errorText}>{errors.description}</p>}
            </div>
            <div>
              <label className={label}>Image</label>
              <label
                className={`mt-1 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition ${
                  uploading
                    ? 'cursor-not-allowed border-border opacity-60'
                    : 'border-border hover:border-primary/50 hover:bg-muted/30'
                }`}
              >
                {uploading ? (
                  <>
                    <Loader2 size={20} className="animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Uploading…</span>
                  </>
                ) : fileName ? (
                  <>
                    <FileImage size={20} className="text-primary" />
                    <span className="max-w-full truncate text-sm font-medium">{fileName}</span>
                    <span className="text-xs text-muted-foreground">Click to replace</span>
                  </>
                ) : (
                  <>
                    <UploadCloud size={20} className="text-muted-foreground" />
                    <span className="text-sm font-medium">Click to upload an image</span>
                    <span className="text-xs text-muted-foreground">JPEG, PNG, WEBP or GIF · up to 5MB</span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  disabled={uploading}
                  onChange={handleFile}
                />
              </label>
              {fileName && !uploading && (
                <button
                  type="button"
                  className="mt-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setImageUrl('')
                    setFileName(null)
                  }}
                >
                  Remove Image
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div className="order-1 flex flex-col border-b border-border bg-gradient-to-b from-muted/30 to-transparent p-6 pt-8 md:order-2 md:border-b-0 md:border-l">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Live preview</p>
          <div className="mx-auto mt-3 w-full max-w-[240px] overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="group">
              <ItemVisual imageUrl={imageUrl} status={status} />
            </div>
            <ItemCardBody
              name={name}
              categoryName={previewCategoryName}
              price={price === '' ? 0 : Number(price)}
              currency={currency}
              description={description}
              taxLabel={previewTaxLabel}
            />
          </div>
          <p className="mt-3 text-center text-xs text-muted-foreground">This is how the item will look on the menu</p>

          <div className="mt-5 flex items-center justify-between gap-2">
            <button
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium uppercase tracking-wide text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium uppercase tracking-wide text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pending || uploading}
              onClick={submit}
            >
              {pending && <Loader2 size={15} className="animate-spin" />}
              {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Item'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
