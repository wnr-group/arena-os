'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Boxes, CheckCircle2, XCircle, Loader2, ImageOff, UploadCloud, FileImage, CalendarDays, FileText, Wallet, Users, SlidersHorizontal, Palette, PackagePlus } from 'lucide-react'
import { upsertResourceType, deleteResourceType, uploadResourceTypeImage } from '@/lib/actions/resources'
import { formatMoney } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { STAT_TINT_CLASSES, type StatTint } from '@/lib/ui/statTint'
import { HolidayRatesModal, type HolidayRateRow } from './HolidayRatesModal'
import { ResourceAddonsModal, type ResourceAddonRow } from './ResourceAddonsModal'

function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(url.split('/').pop() || url)
  } catch {
    return url
  }
}

/** Currency symbol for the rate field's label (e.g. "₹ per hour") — falls
 *  back to the ISO code itself if Intl doesn't recognize it. */
function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
      .formatToParts(0)
      .find((p) => p.type === 'currency')
    return part?.value ?? currency
  } catch {
    return currency
  }
}

type TypeRow = {
  id: string
  name: string
  description: string | null
  hourlyRate: string
  /** M22 #3: null = no weekend pricing configured for this type — weekend
   *  bills identically to weekday (see lib/booking/rate.ts:resolveDayRate). */
  weekendRate: string | null
  bufferMinutes: number
  capacity: number | null
  color: string | null
  imageUrl: string | null
  taxRateId: string | null
  taxRateName: string | null
  // M21 per-head #3: 'per_resource' (today's behaviour — rate × time) or
  // 'per_head' (rate × players × time). Kept as `string`, not a union, to
  // match the column's type across the app (lib/booking/service.ts).
  pricingMode: string
  minPlayers: number
  /** M29 #2: board pricing (per_resource only). extraPlayerRate null = off. */
  includedPlayers: number
  extraPlayerRate: string | null
  extraPlayerWeekendRate: string | null
  isActive: boolean
}
type TaxRateRow = { id: string; name: string; percent: string; appliesTo: 'food' | 'resources' | 'both' }
type Modal = { mode: 'add' } | { mode: 'edit'; row: TypeRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void
type HolidayTarget = { resourceTypeId: string; resourceTypeName: string }
type AddonTarget = { resourceTypeId: string; resourceTypeName: string }

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

/** A type with no tax_rate_id of its own is still taxed when the tenant has
 *  exactly one eligible rate (see lib/tax-rates/resolve.ts) — surfaces that
 *  rate's name instead of a blank "—" that reads as untaxed. */
function effectiveTaxLabel(
  taxRateName: string | null,
  autoTaxRate: { id: string; name: string; percent: string } | null,
): string | null {
  return taxRateName ?? autoTaxRate?.name ?? null
}

function Thumb({ imageUrl, size = 44 }: { imageUrl: string | null; size?: number }) {
  return imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt=""
      className="shrink-0 rounded-md border border-border object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className="flex shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-muted-foreground/40"
      style={{ width: size, height: size }}
    >
      <ImageOff size={size * 0.4} />
    </div>
  )
}

/** Settings page for creating/editing resource types (tables, consoles, rooms, etc). */
export function ResourceTypesManager({
  currency,
  types,
  taxRates,
  autoTaxRate = null,
  industry,
  ratesByType,
  branches,
  addonsByType,
}: {
  currency: string
  types: TypeRow[]
  taxRates: TaxRateRow[]
  /** The rate a type with no tax_rate_id of its own actually gets charged at
   *  (lib/tax-rates/resolve.ts's findScopeDefaultTaxRate) — null when zero or
   *  more than one eligible rate exists. */
  autoTaxRate?: { id: string; name: string; percent: string } | null
  /** Gates the simplified name/capacity-only form in TypeModal — restaurant
   *  tenants only, every other industry's dialog is unaffected. */
  industry: string
  /** M27 #3 — every type's holiday_rates entries, keyed by resourceTypeId. A
   *  type with none simply gets an empty editor ("no holiday rates yet"),
   *  not an error. */
  ratesByType: Record<string, HolidayRateRow[]>
  /** M33 — the tenant's branches (primary first); add-on stock is pooled per
   *  branch. Empty hides the editor. addonsByType holds every branch's rows. */
  branches: { id: string; name: string }[]
  addonsByType: Record<string, ResourceAddonRow[]>
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [holidayTarget, setHolidayTarget] = useState<HolidayTarget | null>(null)
  const [addonTarget, setAddonTarget] = useState<AddonTarget | null>(null)
  // A table isn't priced by the hour (see TypeModal), so there's nothing
  // meaningful to show in a Rate/Tax column for a restaurant tenant.
  const isRestaurant = industry === 'restaurant'
  const columnCount = isRestaurant ? 3 : 5

  /** Run a server action, surfacing its error via toast/state or refreshing + calling onSuccess. */
  const run: Run = (fn, onSuccess) => {
    start(async () => {
      const r = await fn()
      if (r.error) {
        toast.error(r.error)
      } else {
        router.refresh()
        onSuccess?.()
      }
    })
  }

  const stats = useMemo(() => {
    const total = types.length
    const active = types.filter((t) => t.isActive).length
    return { total, active, inactive: total - active }
  }, [types])

  async function handleDelete(row: TypeRow) {
    await confirm({
      title: `Delete resource type "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteResourceType(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          router.refresh()
          toast.success(`Resource type "${row.name}" deleted.`)
        }
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={Boxes} label="Total types" value={stats.total} tint="rose" />
        <StatCard icon={CheckCircle2} label="Active" value={stats.active} tint="mint" />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} tint="slate" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">All resource types</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={16} /> Add Resource Type
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Type</th>
                {!isRestaurant && <th className="px-4 py-3 font-medium">Rate</th>}
                {!isRestaurant && <th className="px-4 py-3 font-medium">Tax</th>}
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {types.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No resource types yet. Add one to get started.
                  </td>
                </tr>
              )}
              {types.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {/* Restaurant tenants never set a photo (no photo
                       *  field in TypeModal for them) — skip the thumbnail
                       *  instead of showing an empty placeholder box. */}
                      {!isRestaurant && <Thumb imageUrl={row.imageUrl} />}
                      <div>
                        <p className="font-medium">{row.name}</p>
                        {(row.capacity || row.bufferMinutes > 0) && (
                          <p className="text-sm text-muted-foreground">
                            {row.capacity ? `cap ${row.capacity}` : ''}
                            {row.capacity && row.bufferMinutes > 0 ? ' · ' : ''}
                            {row.bufferMinutes > 0 ? `${row.bufferMinutes}m buffer` : ''}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  {!isRestaurant && (
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatMoney(row.hourlyRate, currency)}/{row.pricingMode === 'per_head' ? 'player/hr' : 'hr'}
                      {row.weekendRate && (
                        <p className="text-xs">
                          {formatMoney(row.weekendRate, currency)}/{row.pricingMode === 'per_head' ? 'player/hr' : 'hr'}{' '}
                          weekend
                        </p>
                      )}
                    </td>
                  )}
                  {!isRestaurant && (
                    <td className="px-4 py-3 text-muted-foreground">{effectiveTaxLabel(row.taxRateName, autoTaxRate) ?? '—'}</td>
                  )}
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${
                        row.isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {row.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {/* M27 #3: meaningless for a restaurant tenant, same
                       *  reason the Rate/Tax columns above are hidden for
                       *  one — its table types aren't priced by the hour. */}
                      {!isRestaurant && (
                        <button
                          className={btn}
                          onClick={() => setHolidayTarget({ resourceTypeId: row.id, resourceTypeName: row.name })}
                          aria-label={`Holiday rates for ${row.name}`}
                        >
                          <CalendarDays size={16} />
                        </button>
                      )}
                      {/* M33: add-ons are offered for every industry's resource
                       *  types — except a restaurant's tables, which have no
                       *  booking_slots row to attach them to. */}
                      {!isRestaurant && branches.length > 0 && (
                        <button
                          className={btn}
                          onClick={() => setAddonTarget({ resourceTypeId: row.id, resourceTypeName: row.name })}
                          aria-label={`Add-ons for ${row.name}`}
                        >
                          <PackagePlus size={16} />
                        </button>
                      )}
                      <button className={btn} onClick={() => setModal({ mode: 'edit', row })} aria-label="Edit">
                        <Pencil size={16} />
                      </button>
                      <button
                        className={`${btn} text-destructive`}
                        disabled={pending}
                        onClick={() => handleDelete(row)}
                        aria-label="Delete"
                      >
                        {deletingId === row.id && pending ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <TypeModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          currency={currency}
          industry={industry}
          taxRates={taxRates}
          autoTaxRate={autoTaxRate}
          pending={pending}
          run={run}
          onClose={() => setModal(null)}
        />
      )}

      {holidayTarget && (
        <HolidayRatesModal
          resourceTypeId={holidayTarget.resourceTypeId}
          resourceTypeName={holidayTarget.resourceTypeName}
          currency={currency}
          rates={ratesByType[holidayTarget.resourceTypeId] ?? []}
          onClose={() => setHolidayTarget(null)}
        />
      )}

      {addonTarget && branches.length > 0 && (
        <ResourceAddonsModal
          resourceTypeId={addonTarget.resourceTypeId}
          resourceTypeName={addonTarget.resourceTypeName}
          branches={branches}
          currency={currency}
          addons={addonsByType[addonTarget.resourceTypeId] ?? []}
          onClose={() => setAddonTarget(null)}
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

/** Image/placeholder block shared by the modal's live preview. */
function TypeVisual({ imageUrl, isActive }: { imageUrl?: string | null; isActive: boolean }) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-muted/70 to-muted/20">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
          <Boxes size={30} />
        </div>
      )}
      <span
        className={`absolute left-2 top-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur-sm ${
          isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
        }`}
      >
        {isActive ? 'Active' : 'Inactive'}
      </span>
    </div>
  )
}

/** Name/rate/capacity/description block shared by the modal's live preview
 *  (non-restaurant tenants only — see TypeModal, which skips this panel
 *  entirely for a restaurant's table types). */
function TypeCardBody({
  name,
  rate,
  currency,
  capacity,
  bufferMinutes,
  description,
  perPlayer = false,
}: {
  name: string
  rate: number | string
  currency: string
  capacity?: number | null
  bufferMinutes?: number
  description?: string | null
  /** M21 per-head #3: the type's pricing_mode is 'per_head' — the preview
   *  price is per player, not per resource. */
  perPlayer?: boolean
}) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 text-base font-semibold">{name || 'Untitled type'}</h3>
        <span className="shrink-0 text-base font-semibold text-primary">
          {formatMoney(rate, currency)}/{perPlayer ? 'player/hr' : 'hr'}
        </span>
      </div>
      {((capacity ?? 0) > 0 || (bufferMinutes ?? 0) > 0) && (
        <p className="mt-0.5 text-sm text-muted-foreground">
          {capacity ? `cap ${capacity}` : ''}
          {capacity && bufferMinutes ? ' · ' : ''}
          {bufferMinutes ? `${bufferMinutes}m buffer` : ''}
        </p>
      )}
      {description && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground/80">{description}</p>}
    </div>
  )
}

function TypeModal({
  row,
  currency,
  industry,
  taxRates,
  autoTaxRate,
  pending,
  run,
  onClose,
}: {
  row?: TypeRow
  currency: string
  industry: string
  taxRates: TaxRateRow[]
  autoTaxRate: { id: string; name: string; percent: string } | null
  pending: boolean
  run: Run
  onClose: () => void
}) {
  // Restaurant tenants only: a table isn't priced by the hour, doesn't need
  // a buffer/color/photo/tax, and is active the moment it's created — so the
  // dialog collects only what actually matters for a table, name and seat
  // count. Every other field still submits (upsertResourceType/the schema
  // are unchanged) — it just keeps its default value since its input never
  // renders. Every other industry's dialog is completely unaffected.
  const isRestaurant = industry === 'restaurant'
  const [name, setName] = useState(row?.name ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [rate, setRate] = useState(row?.hourlyRate ?? '')
  const [weekendRate, setWeekendRate] = useState(row?.weekendRate ?? '')
  const [buffer, setBuffer] = useState(String(row?.bufferMinutes ?? 0))
  const [capacity, setCapacity] = useState(row?.capacity ? String(row.capacity) : '')
  const [color, setColor] = useState(row?.color ?? '')
  // Falls back to the tenant's auto-applied default (if any) so the dropdown
  // shows what's actually being charged — matching the table's Tax column —
  // instead of sitting on "No tax" for a type that's really being taxed via
  // the implicit scope default (lib/tax-rates/resolve.ts).
  const [taxRateId, setTaxRateId] = useState(row?.taxRateId ?? autoTaxRate?.id ?? '')
  const [pricingMode, setPricingMode] = useState<'per_resource' | 'per_head'>(
    row?.pricingMode === 'per_head' ? 'per_head' : 'per_resource',
  )
  const [minPlayers, setMinPlayers] = useState(String(row?.minPlayers ?? 1))
  const [includedPlayers, setIncludedPlayers] = useState(String(row?.includedPlayers ?? 1))
  const [extraPlayerRate, setExtraPlayerRate] = useState(row?.extraPlayerRate ?? '')
  const [extraPlayerWeekendRate, setExtraPlayerWeekendRate] = useState(row?.extraPlayerWeekendRate ?? '')
  // Board extra-player pricing: gaming_cafe + per-station types only. Hiding
  // is a convenience — upsertResourceType re-validates both.
  const showSurcharge = industry === 'gaming_cafe' && pricingMode === 'per_resource'
  const [isActive, setIsActive] = useState(row?.isActive ?? true)
  const [imageUrl, setImageUrl] = useState(row?.imageUrl ?? '')
  const [fileName, setFileName] = useState<string | null>(row?.imageUrl ? fileNameFromUrl(row.imageUrl) : null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const errors = useMemo(() => {
    const e: {
      name?: string
      description?: string
      rate?: string
      weekendRate?: string
      buffer?: string
      capacity?: string
      minPlayers?: string
      includedPlayers?: string
      extraPlayerRate?: string
      extraPlayerWeekendRate?: string
    } = {}
    if (!name.trim()) e.name = 'Name is required.'
    else if (name.trim().length < 2) e.name = 'Name must be at least 2 characters.'
    else if (name.trim().length > 100) e.name = 'Name must be at most 100 characters.'
    if (description.trim() && description.trim().length < 5) e.description = 'Description must be at least 5 characters.'
    if (rate !== '' && (Number.isNaN(Number(rate)) || Number(rate) < 0)) e.rate = 'Enter a valid rate.'
    // Blank is valid (M22 #3: no weekend pricing) — only reject a value that
    // was actually entered but isn't a non-negative number.
    if (weekendRate !== '' && (Number.isNaN(Number(weekendRate)) || Number(weekendRate) < 0))
      e.weekendRate = 'Enter a valid rate, or leave it blank.'
    if (buffer !== '' && (Number.isNaN(Number(buffer)) || !Number.isInteger(Number(buffer))))
      e.buffer = 'Buffer must be a whole number.'
    if (capacity !== '' && (Number.isNaN(Number(capacity)) || Number(capacity) <= 0))
      e.capacity = 'Capacity must be a positive number.'
    if (pricingMode === 'per_head' && (Number.isNaN(Number(minPlayers)) || !Number.isInteger(Number(minPlayers)) || Number(minPlayers) < 1))
      e.minPlayers = 'Minimum players must be a whole number of at least 1.'
    if (showSurcharge) {
      const n = Number(includedPlayers)
      if (includedPlayers === '' || !Number.isInteger(n) || n < 1 || n > 1000)
        e.includedPlayers = 'Included players must be a whole number from 1 to 1000.'
      if (extraPlayerRate !== '' && (Number.isNaN(Number(extraPlayerRate)) || Number(extraPlayerRate) < 0))
        e.extraPlayerRate = 'Enter a valid rate, or leave it blank.'
      if (extraPlayerWeekendRate !== '') {
        if (Number.isNaN(Number(extraPlayerWeekendRate)) || Number(extraPlayerWeekendRate) < 0)
          e.extraPlayerWeekendRate = 'Enter a valid rate, or leave it blank.'
        else if (extraPlayerRate === '') e.extraPlayerWeekendRate = 'Set an extra player rate first.'
      }
    }
    return e
  }, [name, description, rate, weekendRate, buffer, capacity, pricingMode, minPlayers, showSurcharge, includedPlayers, extraPlayerRate, extraPlayerWeekendRate])
  const isValid = Object.keys(errors).length === 0
  // A rate scoped to 'food' only isn't valid on a resource type — the server
  // rejects it too (lib/actions/resources.ts) — but keep the current
  // selection visible even if it no longer qualifies, same as
  // MenuItemsManager's selectableTaxRates.
  const selectableTaxRates = taxRates.filter((t) => t.appliesTo !== 'food' || t.id === taxRateId)

  useBodyScrollLock()

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    const r = await uploadResourceTypeImage(fd)
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
        upsertResourceType({
          id: row?.id,
          name: name.trim(),
          description,
          hourlyRate: rate === '' ? 0 : Number(rate),
          weekendRate: weekendRate === '' ? null : Number(weekendRate),
          bufferMinutes: buffer === '' ? 0 : Number(buffer),
          capacity: capacity === '' ? undefined : Number(capacity),
          color,
          imageUrl,
          taxRateId: taxRateId || null,
          pricingMode,
          minPlayers: minPlayers === '' ? 1 : Number(minPlayers),
          includedPlayers: showSurcharge ? Number(includedPlayers) : 1,
          extraPlayerRate: showSurcharge && extraPlayerRate !== '' ? Number(extraPlayerRate) : null,
          extraPlayerWeekendRate:
            showSurcharge && extraPlayerRate !== '' && extraPlayerWeekendRate !== '' ? Number(extraPlayerWeekendRate) : null,
          isActive,
        }),
      () => {
        toast.success(row ? `Resource type "${name.trim()}" updated.` : `Resource type "${name.trim()}" added.`)
        onClose()
      },
    )
  }


  const fieldLabel = 'mb-1.5 block text-xs font-medium text-muted-foreground'
  const hasExtra = showSurcharge && extraPlayerRate !== ''
  const swatches = ['#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#10b981', '#06b6d4', '#64748b']
  const validColor = /^#[0-9a-fA-F]{6}$/.test(color)

  const title = isRestaurant
    ? row
      ? 'Edit table type'
      : 'Add table type'
    : row
      ? 'Edit resource type'
      : 'Add resource type'
  const subtitle = isRestaurant
    ? 'Just a name and how many guests it seats.'
    : 'Set up pricing and booking rules — the preview updates as you type.'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl ${
          isRestaurant ? 'max-w-md' : 'max-w-5xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border bg-gradient-to-b from-muted/40 to-transparent px-6 py-5">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <Boxes size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{title}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div
          className={`grid min-h-0 flex-1 overflow-y-auto ${isRestaurant ? 'grid-cols-1' : 'md:grid-cols-[minmax(0,1fr)_300px]'}`}
        >
          <div className="space-y-4 px-6 py-5">
            {uploadError && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {uploadError}
              </p>
            )}

            {isRestaurant ? (
              <>
                <div>
                  <label className={fieldLabel}>
                    Name <span className="text-destructive">*</span>
                  </label>
                  <input
                    className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
                    placeholder="e.g. 4-Seater"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    autoFocus
                  />
                  {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
                </div>
                <div>
                  <label className={fieldLabel}>Capacity (optional)</label>
                  <input
                    className={`${input} ${submitted && errors.capacity ? inputInvalid : ''}`}
                    type="number"
                    min="1"
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                  {submitted && errors.capacity && <p className={errorText}>{errors.capacity}</p>}
                </div>
              </>
            ) : (
              <>
                {/* 1 · Basics */}
                <ModalSection icon={<FileText size={15} />} title="Basics" hint="What customers will see.">
                  <div>
                    <label className={fieldLabel}>
                      Name <span className="text-destructive">*</span>
                    </label>
                    <input
                      className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
                      placeholder="e.g. PS5 Station"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={100}
                      autoFocus
                    />
                    {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
                  </div>
                  <div>
                    <label className={fieldLabel}>Description (optional)</label>
                    <textarea
                      className={`${input} resize-none ${submitted && errors.description ? inputInvalid : ''}`}
                      rows={2}
                      placeholder="A short line about this type"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                    {submitted && errors.description && <p className={errorText}>{errors.description}</p>}
                  </div>
                  <div>
                    <label className={fieldLabel}>Photo (optional)</label>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 transition ${
                        uploading
                          ? 'cursor-not-allowed border-border opacity-60'
                          : 'border-border hover:border-primary/50 hover:bg-muted/30'
                      }`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        {uploading ? (
                          <Loader2 size={18} className="animate-spin" />
                        ) : fileName ? (
                          <FileImage size={18} className="text-primary" />
                        ) : (
                          <UploadCloud size={18} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {uploading ? 'Uploading…' : fileName ?? 'Click to upload a photo'}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {fileName && !uploading ? 'Click to replace' : 'JPEG, PNG, WEBP or GIF · up to 5MB'}
                        </span>
                      </span>
                      {fileName && !uploading && (
                        <button
                          type="button"
                          className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                          onClick={(e) => {
                            e.preventDefault()
                            setImageUrl('')
                            setFileName(null)
                          }}
                        >
                          Remove
                        </button>
                      )}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        disabled={uploading}
                        onChange={handleFile}
                      />
                    </label>
                  </div>
                </ModalSection>

                {/* 2 · Pricing */}
                <ModalSection icon={<Wallet size={15} />} title="Pricing" hint="How this type is billed.">
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        { id: 'per_resource', title: 'Per station', desc: 'One rate per booking', Icon: Boxes },
                        { id: 'per_head', title: 'Per head', desc: 'Rate × number of players', Icon: Users },
                      ] as const
                    ).map(({ id, title: t, desc, Icon }) => {
                      const active = pricingMode === id
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setPricingMode(id)}
                          className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                            active
                              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                              : 'border-border hover:bg-muted/40'
                          }`}
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                              active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            <Icon size={16} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">{t}</span>
                            <span className="block truncate text-xs text-muted-foreground">{desc}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {pricingMode === 'per_head' && (
                    <p className="text-xs text-muted-foreground">
                      Billed per player instead of per booking. Switching an existing type is explicit and only
                      affects new bookings — bills already made keep their original rate.
                    </p>
                  )}

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={fieldLabel}>
                        Weekday rate ({pricingMode === 'per_head' ? 'per player / hr' : 'per hr'})
                      </label>
                      <MoneyInput
                        symbol={currencySymbol(currency)}
                        invalid={submitted && !!errors.rate}
                        value={rate}
                        onChange={setRate}
                        placeholder="0"
                      />
                      {submitted && errors.rate && <p className={errorText}>{errors.rate}</p>}
                    </div>
                    <div>
                      <label className={fieldLabel}>Weekend rate (optional)</label>
                      <MoneyInput
                        symbol={currencySymbol(currency)}
                        invalid={submitted && !!errors.weekendRate}
                        value={weekendRate}
                        onChange={setWeekendRate}
                        placeholder="Same as weekday"
                      />
                      {submitted && errors.weekendRate && <p className={errorText}>{errors.weekendRate}</p>}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Weekend rate applies on the days set under{' '}
                    <span className="font-medium text-foreground">Weekend days</span> above, tenant-wide. A
                    station&apos;s own rate override (Resources page) only changes the weekday rate.
                  </p>

                  {showSurcharge && (
                    <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/[0.03] p-3.5">
                      <div>
                        <p className="text-sm font-semibold">Extra-player pricing</p>
                        <p className="text-xs text-muted-foreground">
                          The station rate covers the included players; each extra player adds a per-hour charge.
                          Leave the rate blank to turn it off.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div>
                          <label className={fieldLabel}>Included players</label>
                          <input
                            className={`${input} ${submitted && errors.includedPlayers ? inputInvalid : ''}`}
                            type="number"
                            min="1"
                            max="1000"
                            step="1"
                            value={includedPlayers}
                            onChange={(e) => setIncludedPlayers(e.target.value)}
                          />
                          {submitted && errors.includedPlayers && <p className={errorText}>{errors.includedPlayers}</p>}
                        </div>
                        <div>
                          <label className={fieldLabel}>Extra player / hr</label>
                          <MoneyInput
                            symbol={currencySymbol(currency)}
                            invalid={submitted && !!errors.extraPlayerRate}
                            value={extraPlayerRate}
                            onChange={setExtraPlayerRate}
                            placeholder="Off"
                          />
                          {submitted && errors.extraPlayerRate && <p className={errorText}>{errors.extraPlayerRate}</p>}
                        </div>
                        <div>
                          <label className={fieldLabel}>Extra player / hr (weekend)</label>
                          <MoneyInput
                            symbol={currencySymbol(currency)}
                            invalid={submitted && !!errors.extraPlayerWeekendRate}
                            value={extraPlayerWeekendRate}
                            onChange={setExtraPlayerWeekendRate}
                            placeholder="Same as weekday"
                          />
                          {submitted && errors.extraPlayerWeekendRate && (
                            <p className={errorText}>{errors.extraPlayerWeekendRate}</p>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Only affects new bookings — bookings already made keep what they were charged.
                      </p>
                    </div>
                  )}

                  <div>
                    <label className={fieldLabel}>Tax rate</label>
                    <select className={input} value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
                      <option value="">No tax</option>
                      {selectableTaxRates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.percent}%)
                        </option>
                      ))}
                    </select>
                  </div>
                </ModalSection>

                {/* 3 · Booking rules */}
                <ModalSection icon={<SlidersHorizontal size={15} />} title="Booking rules">
                  <div className={`grid grid-cols-1 gap-3 ${pricingMode === 'per_head' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
                    <div>
                      <label className={fieldLabel}>Buffer (minutes)</label>
                      <input
                        className={`${input} ${submitted && errors.buffer ? inputInvalid : ''}`}
                        type="number"
                        min="0"
                        value={buffer}
                        onChange={(e) => setBuffer(e.target.value)}
                      />
                      {submitted && errors.buffer && <p className={errorText}>{errors.buffer}</p>}
                    </div>
                    <div>
                      <label className={fieldLabel}>Capacity (optional)</label>
                      <input
                        className={`${input} ${submitted && errors.capacity ? inputInvalid : ''}`}
                        type="number"
                        min="1"
                        value={capacity}
                        onChange={(e) => setCapacity(e.target.value)}
                      />
                      {submitted && errors.capacity && <p className={errorText}>{errors.capacity}</p>}
                    </div>
                    {pricingMode === 'per_head' && (
                      <div>
                        <label className={fieldLabel}>Minimum players</label>
                        <input
                          className={`${input} ${submitted && errors.minPlayers ? inputInvalid : ''}`}
                          type="number"
                          min="1"
                          step="1"
                          value={minPlayers}
                          onChange={(e) => setMinPlayers(e.target.value)}
                        />
                        {submitted && errors.minPlayers && <p className={errorText}>{errors.minPlayers}</p>}
                      </div>
                    )}
                  </div>
                </ModalSection>

                {/* 4 · Appearance & status */}
                <ModalSection icon={<Palette size={15} />} title="Appearance & status">
                  <div>
                    <label className={fieldLabel}>Calendar color (optional)</label>
                    <div className="flex flex-wrap items-center gap-2">
                      {swatches.map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-label={`Use ${c}`}
                          onClick={() => setColor(color === c ? '' : c)}
                          className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-card transition hover:scale-110 ${
                            color.toLowerCase() === c ? 'ring-2 ring-foreground' : ''
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                      <div className="relative ml-1 w-32">
                        <span
                          className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border border-border"
                          style={{ backgroundColor: validColor ? color : 'transparent' }}
                        />
                        <input
                          className={`${input} py-1.5 pl-8 text-sm`}
                          placeholder="#3b82f6"
                          value={color}
                          onChange={(e) => setColor(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-3">
                    <div>
                      <p className="text-sm font-medium">Active</p>
                      <p className="text-xs text-muted-foreground">Inactive types can’t be booked.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isActive}
                      aria-label="Active"
                      onClick={() => setIsActive(!isActive)}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition ${isActive ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${isActive ? 'left-[22px]' : 'left-0.5'}`}
                      />
                    </button>
                  </div>
                </ModalSection>
              </>
            )}
          </div>

          {/* Live preview — every other industry only; a table type has no
           *  photo/color/pricing to preview. */}
          {!isRestaurant && (
            <aside className="hidden border-l border-border bg-muted/20 p-5 md:block">
              <div className="sticky top-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Live preview</p>
                <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                  <div className="group">
                    <TypeVisual imageUrl={imageUrl} isActive={isActive} />
                  </div>
                  <TypeCardBody
                    name={name}
                    rate={rate === '' ? 0 : Number(rate)}
                    currency={currency}
                    capacity={capacity === '' ? null : Number(capacity)}
                    bufferMinutes={buffer === '' ? 0 : Number(buffer)}
                    description={description}
                    perPlayer={pricingMode === 'per_head'}
                  />
                  {(weekendRate !== '' || hasExtra) && (
                    <div className="space-y-1 border-t border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
                      {weekendRate !== '' && !Number.isNaN(Number(weekendRate)) && (
                        <p>
                          Weekend:{' '}
                          <span className="font-medium text-foreground">
                            {formatMoney(Number(weekendRate), currency)}/{pricingMode === 'per_head' ? 'player/hr' : 'hr'}
                          </span>
                        </p>
                      )}
                      {hasExtra && !Number.isNaN(Number(extraPlayerRate)) && (
                        <p>
                          Includes {Number(includedPlayers) || 1} player{Number(includedPlayers) === 1 ? '' : 's'}, then{' '}
                          <span className="font-medium text-foreground">
                            +{formatMoney(Number(extraPlayerRate), currency)}/hr
                          </span>{' '}
                          each
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </aside>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-6 py-3.5">
          <button
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending || uploading}
            onClick={submit}
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save Changes' : isRestaurant ? 'Add Table Type' : 'Add Resource Type'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A titled card that groups related fields inside the type modal. */
function ModalSection({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <span className="text-xs text-muted-foreground">· {hint}</span>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/** Number input with a currency symbol prefix. */
function MoneyInput({
  symbol,
  value,
  onChange,
  invalid,
  placeholder,
}: {
  symbol: string
  value: string
  onChange: (v: string) => void
  invalid?: boolean
  placeholder?: string
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        {symbol}
      </span>
      <input
        className={`${input} pl-8 ${invalid ? inputInvalid : ''}`}
        type="number"
        min="0"
        step="0.01"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
