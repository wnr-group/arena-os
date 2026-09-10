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
  Boxes,
  CheckCircle2,
  Wrench,
  XCircle,
  LayoutGrid,
  Table2,
  Search,
  Filter,
  ChevronDown,
  Loader2,
  UploadCloud,
  FileImage,
  QrCode,
} from 'lucide-react'
import { upsertResource, deleteResource, uploadResourceImage } from '@/lib/actions/resources'
import { formatMoney } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { STAT_TINT_CLASSES, type StatTint } from '@/lib/ui/statTint'

function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(url.split('/').pop() || url)
  } catch {
    return url
  }
}

type TypeOption = { id: string; name: string; hourlyRate: string; imageUrl: string | null; isActive: boolean }
type ResourceStatus = 'available' | 'maintenance' | 'inactive'
type ResourceRow = {
  id: string
  name: string
  status: ResourceStatus
  resourceTypeId: string
  typeName: string
  rateOverride: string | null
  imageUrl: string | null
  description: string | null
  typeImageUrl: string | null
  typeDescription: string | null
  qrToken: string
}
type Modal = { mode: 'add' } | { mode: 'edit'; row: ResourceRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void, onSettled?: () => void) => void
type View = 'table' | 'grid'

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'

const STATUS_LABELS: Record<ResourceStatus, string> = {
  available: 'Available',
  maintenance: 'Maintenance',
  inactive: 'Inactive',
}
const STATUS_BADGE: Record<ResourceStatus, string> = {
  available: 'bg-emerald-500/10 text-emerald-600',
  maintenance: 'bg-amber-500/10 text-amber-600',
  inactive: 'bg-muted text-muted-foreground',
}

export function ResourcesManager({
  branchId,
  currency,
  industry,
  types,
  resources,
}: {
  branchId: string
  currency: string
  /** Gates the simplified name/type/status-only form in ResourceModal —
   *  restaurant tenants only, every other industry's dialog is unaffected. */
  industry: string
  types: TypeOption[]
  resources: ResourceRow[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Restaurant tenants only see the table view — a table list reads better
  // as rows than as photo cards, and there's no grid toggle for them to
  // switch away with (see below). Every other industry keeps grid as the
  // default, unaffected.
  const isRestaurant = industry === 'restaurant'
  const [view, setView] = useState<View>(isRestaurant ? 'table' : 'grid')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ResourceStatus>('all')

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
    const total = resources.length
    const available = resources.filter((r) => r.status === 'available').length
    const maintenance = resources.filter((r) => r.status === 'maintenance').length
    const inactive = resources.filter((r) => r.status === 'inactive').length
    return { total, available, maintenance, inactive }
  }, [resources])

  // Inactive types are retired — don't offer them as a filter, even if
  // existing resources still reference one (those stay visible under "All
  // types", they just don't get their own tab).
  const filterableTypes = useMemo(() => types.filter((t) => t.isActive), [types])

  const filteredResources = useMemo(() => {
    const q = search.trim().toLowerCase()
    return resources.filter((row) => {
      if (typeFilter !== 'all' && row.resourceTypeId !== typeFilter) return false
      if (statusFilter !== 'all' && row.status !== statusFilter) return false
      if (q && !row.name.toLowerCase().includes(q) && !(row.description ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [resources, search, typeFilter, statusFilter])

  const filtersActive = search.trim() !== '' || typeFilter !== 'all' || statusFilter !== 'all'

  function resetFilters() {
    setSearch('')
    setTypeFilter('all')
    setStatusFilter('all')
  }

  async function handleDelete(row: ResourceRow) {
    await confirm({
      title: `Delete resource "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteResource(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          router.refresh()
          toast.success(`Resource "${row.name}" deleted.`)
        }
      },
    })
  }

  if (types.length === 0) {
    return (
      <p className="mt-8 rounded-md border border-dashed p-4 text-base text-muted-foreground">
        Add a{' '}
        <Link href="/settings/resources/types" className="font-medium text-primary hover:underline">
          resource type
        </Link>{' '}
        first before adding resources.
      </p>
    )
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Boxes} label="Total resources" value={stats.total} tint="rose" />
        <StatCard icon={CheckCircle2} label="Available" value={stats.available} tint="mint" />
        <StatCard icon={Wrench} label="Maintenance" value={stats.maintenance} tint="amber" />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} tint="slate" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
          All resources {resources.length > 0 && <span className="text-muted-foreground/60">({filteredResources.length})</span>}
        </h2>
        <div className="flex items-center gap-2">
          {!isRestaurant && (
            <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-1">
              <button
                type="button"
                className={`inline-flex items-center rounded-md p-1.5 transition ${
                  view === 'grid' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setView('grid')}
                aria-pressed={view === 'grid'}
                aria-label="Grid view"
                title="Grid view"
              >
                <LayoutGrid size={15} />
              </button>
              <button
                type="button"
                className={`inline-flex items-center rounded-md p-1.5 transition ${
                  view === 'table' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setView('table')}
                aria-pressed={view === 'table'}
                aria-label="Table view"
                title="Table view"
              >
                <Table2 size={15} />
              </button>
            </div>
          )}
          <button
            className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            onClick={() => setModal({ mode: 'add' })}
          >
            <Plus size={16} /> Add Resource
          </button>
        </div>
      </div>

      {resources.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card/50 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
              <input
                className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                placeholder="Search resources by name or description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="relative">
              <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <select
                className="appearance-none rounded-lg border border-border bg-background py-2.5 pl-9 pr-9 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | ResourceStatus)}
              >
                <option value="all">All statuses</option>
                <option value="available">Available</option>
                <option value="maintenance">Maintenance</option>
                <option value="inactive">Inactive</option>
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
            <TypeTab active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>
              All Types
            </TypeTab>
            {filterableTypes.map((t) => (
              <TypeTab key={t.id} active={typeFilter === t.id} onClick={() => setTypeFilter(t.id)}>
                {t.name}
              </TypeTab>
            ))}
          </div>
        </div>
      )}

      {resources.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-base text-muted-foreground">
          No resources yet. Add one to get started.
        </p>
      ) : filteredResources.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-base text-muted-foreground">
          No resources match your filters.{' '}
          <button type="button" onClick={resetFilters} className="font-medium uppercase tracking-wide text-primary hover:underline">
            Clear Filters
          </button>
        </p>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredResources.map((row) => {
            const type = types.find((t) => t.id === row.resourceTypeId)
            return (
              <ResourceCard
                key={row.id}
                row={row}
                rate={row.rateOverride ?? type?.hourlyRate ?? null}
                currency={currency}
                pending={pending}
                deleting={deletingId === row.id}
                onEdit={() => setModal({ mode: 'edit', row })}
                onDelete={() => handleDelete(row)}
              />
            )
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-base">
              <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Resource</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  {/* A table doesn't have an hourly rate to override (see
                   *  ResourceModal) — nothing to show for a restaurant tenant. */}
                  {!isRestaurant && <th className="px-4 py-3 font-medium">Rate</th>}
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredResources.map((row) => (
                  <tr key={row.id} className="transition hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {/* Restaurant tenants never set a photo (the dialog
                         *  has no photo field for them — see ResourceModal),
                         *  so this would only ever be an empty placeholder
                         *  box; skip the thumbnail entirely instead. */}
                        {!isRestaurant &&
                          (row.imageUrl ?? row.typeImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={row.imageUrl ?? row.typeImageUrl ?? ''}
                              alt=""
                              className="h-11 w-11 shrink-0 rounded-md border object-cover"
                            />
                          ) : (
                            <div className="h-11 w-11 shrink-0 rounded-md border border-dashed bg-muted/40" />
                          ))}
                        <span className="font-medium">{row.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.typeName}</td>
                    {!isRestaurant && (
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.rateOverride ? `${formatMoney(row.rateOverride, currency)}/hr` : '—'}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${STATUS_BADGE[row.status]}`}>
                        {STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Link
                          href={`/settings/resources/units/${row.id}/qr`}
                          className={btn}
                          aria-label="View / print QR"
                        >
                          <QrCode size={16} />
                        </Link>
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
        <ResourceModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          types={types}
          branchId={branchId}
          currency={currency}
          industry={industry}
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
  tint,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  value: string | number
  tint: StatTint
}) {
  const { card, icon } = STAT_TINT_CLASSES[tint]
  return (
    <div className={`group rounded-xl border p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md sm:p-5 ${card}`}>
      <div className="inline-flex size-9 items-center justify-center rounded-lg bg-white transition-transform duration-300 group-hover:scale-110">
        <Icon size={18} className={icon} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function TypeTab({
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
function ResourceVisual({ imageUrl, status }: { imageUrl?: string | null; status: ResourceStatus }) {
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
          <Boxes size={30} />
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

/** Name/rate/type/description block, shared by the grid card and the modal's live preview. */
function ResourceCardBody({
  name,
  typeName,
  rate,
  currency,
  description,
}: {
  name: string
  typeName?: string | null
  rate: number | string | null
  currency: string
  description?: string | null
}) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 text-base font-semibold">{name || 'Untitled resource'}</h3>
        {rate != null && <span className="shrink-0 text-base font-semibold text-primary">{formatMoney(rate, currency)}/hr</span>}
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">{typeName || 'No type'}</p>
      {description && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground/80">{description}</p>}
    </div>
  )
}

function ResourceCard({
  row,
  rate,
  currency,
  pending,
  deleting,
  onEdit,
  onDelete,
}: {
  row: ResourceRow
  rate: string | null
  currency: string
  pending: boolean
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg">
      <ResourceVisual imageUrl={row.imageUrl ?? row.typeImageUrl} status={row.status} />
      <div
        className={`absolute right-2 top-2 flex gap-1 transition ${
          deleting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <Link
          href={`/settings/resources/units/${row.id}/qr`}
          className="rounded-md border border-border/60 bg-background/90 p-1.5 text-foreground shadow-sm backdrop-blur-sm hover:text-primary"
          aria-label="View / print QR"
        >
          <QrCode size={13} />
        </Link>
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
      <ResourceCardBody name={row.name} typeName={row.typeName} rate={rate} currency={currency} description={row.description ?? row.typeDescription} />
    </div>
  )
}

function ResourceModal({
  row,
  types,
  branchId,
  currency,
  industry,
  pending,
  run,
  onClose,
}: {
  row?: ResourceRow
  types: TypeOption[]
  branchId: string
  currency: string
  industry: string
  pending: boolean
  run: Run
  onClose: () => void
}) {
  // Restaurant tenants only: a table doesn't need a rate override,
  // description, or photo of its own — name, resource type ("4-Seater",
  // "Booth", etc.) and status are all that matter. Every other field still
  // submits (upsertResource/the schema are unchanged) — it just keeps its
  // default value since its input never renders. Every other industry's
  // dialog is completely unaffected.
  const isRestaurant = industry === 'restaurant'
  const [name, setName] = useState(row?.name ?? '')
  const [typeId, setTypeId] = useState(row?.resourceTypeId ?? types.find((t) => t.isActive)?.id ?? '')
  const [status, setStatus] = useState<ResourceStatus>(row?.status ?? 'available')
  const [override, setOverride] = useState(row?.rateOverride ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [imageUrl, setImageUrl] = useState(row?.imageUrl ?? '')
  const [fileName, setFileName] = useState<string | null>(row?.imageUrl ? fileNameFromUrl(row.imageUrl) : null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const selectedType = types.find((t) => t.id === typeId)
  const previewRate = override !== '' ? Number(override) : selectedType ? Number(selectedType.hourlyRate) : null
  const previewImage = imageUrl || selectedType?.imageUrl || null
  // Retired types can't be picked for new/other resources, but stay in the
  // list if this resource is currently assigned to one — otherwise the
  // select would silently reassign it on save.
  const selectableTypes = types.filter((t) => t.isActive || t.id === typeId)

  const errors = useMemo(() => {
    const e: { name?: string; typeId?: string; override?: string } = {}
    if (!name.trim()) e.name = 'Name is required.'
    if (!typeId) e.typeId = 'Select a resource type.'
    if (override !== '' && Number.isNaN(Number(override))) e.override = 'Enter a valid rate.'
    return e
  }, [name, typeId, override])
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
    const r = await uploadResourceImage(fd)
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
        upsertResource({
          id: row?.id,
          branchId,
          resourceTypeId: typeId,
          name: name.trim(),
          status,
          hourlyRateOverride: override === '' ? null : Number(override),
          imageUrl,
          description,
        }),
      () => {
        toast.success(row ? `Resource "${name.trim()}" updated.` : `Resource "${name.trim()}" added.`)
        onClose()
      },
    )
  }

  // Restaurant only: no live preview panel (see below), so the dialog is a
  // single narrow column instead of the two-column form+preview layout.
  const actions = (
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
        {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Resource'}
      </button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`relative grid max-h-[92vh] w-full overflow-y-auto rounded-xl border border-border bg-card shadow-2xl ${
          isRestaurant ? 'max-w-sm grid-cols-1' : 'max-w-4xl grid-cols-1 md:grid-cols-[1.3fr_1fr]'
        }`}
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
          <h2 className="text-xl font-semibold">{row ? 'Edit resource' : 'Add resource'}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isRestaurant ? 'Name, type, and status — that’s it.' : 'Fill in the details — the preview updates as you type.'}
          </p>

          <div className="mt-4 space-y-3">
            {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}

            <div className={isRestaurant ? 'space-y-3' : 'grid grid-cols-2 gap-3'}>
              <div>
                <label className={label}>
                  Name <span className="text-destructive">*</span>
                </label>
                <input
                  className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
                  placeholder={isRestaurant ? 'e.g. T1' : 'e.g. PS5 #1'}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
              </div>
              <div>
                <label className={label}>
                  Resource type <span className="text-destructive">*</span>
                </label>
                <select
                  className={`${input} ${submitted && errors.typeId ? inputInvalid : ''}`}
                  value={typeId}
                  onChange={(e) => setTypeId(e.target.value)}
                >
                  {selectableTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {!t.isActive ? ' (inactive)' : ''}
                    </option>
                  ))}
                </select>
                {submitted && errors.typeId && <p className={errorText}>{errors.typeId}</p>}
              </div>
            </div>

            {isRestaurant ? (
              <div>
                <label className={label}>Status</label>
                <select className={input} value={status} onChange={(e) => setStatus(e.target.value as ResourceStatus)}>
                  <option value="available">Available</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Status</label>
                    <select
                      className={input}
                      value={status}
                      onChange={(e) => setStatus(e.target.value as ResourceStatus)}
                    >
                      <option value="available">Available</option>
                      <option value="maintenance">Maintenance</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                  <div>
                    <label className={label}>
                      Rate override{selectedType ? ` (default ${formatMoney(selectedType.hourlyRate, currency)}/hr)` : ''}
                    </label>
                    <input
                      className={`${input} ${submitted && errors.override ? inputInvalid : ''}`}
                      placeholder="0.00"
                      type="number"
                      min="0"
                      step="0.01"
                      value={override}
                      onChange={(e) => setOverride(e.target.value)}
                    />
                    {submitted && errors.override && <p className={errorText}>{errors.override}</p>}
                  </div>
                </div>

                <div>
                  <label className={label}>Description (optional override)</label>
                  <textarea
                    className={input}
                    rows={2}
                    placeholder="Leave blank to use the resource type's description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>

                <div>
                  <label className={label}>Photo (optional override)</label>
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
                        <span className="text-sm font-medium">Click to upload a photo</span>
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
                  {fileName && !uploading ? (
                    <button
                      type="button"
                      className="mt-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setImageUrl('')
                        setFileName(null)
                      }}
                    >
                      Remove — Use the Type&apos;s Default Photo
                    </button>
                  ) : (
                    !uploading &&
                    selectedType?.imageUrl && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Currently showing the resource type&apos;s default photo.
                      </p>
                    )
                  )}
                </div>
              </>
            )}
          </div>

          {/* Restaurant tenants get no live preview panel (nothing here needs
           *  previewing) — the actions sit right under the form instead. */}
          {isRestaurant && actions}
        </div>

        {/* Live preview — every other industry only; a restaurant table has
         *  no photo/rate/description override to preview. */}
        {!isRestaurant && (
          <div className="order-1 flex flex-col border-b border-border bg-gradient-to-b from-muted/30 to-transparent p-6 pt-8 md:order-2 md:border-b-0 md:border-l">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Live preview</p>
            <div className="mx-auto mt-3 w-full max-w-[240px] overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              <div className="group">
                <ResourceVisual imageUrl={previewImage} status={status} />
              </div>
              <ResourceCardBody
                name={name}
                typeName={selectedType?.name}
                rate={previewRate}
                currency={currency}
                description={description}
              />
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">This is how the resource will look to staff</p>

            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
