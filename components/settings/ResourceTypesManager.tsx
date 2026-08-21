'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Boxes, CheckCircle2, XCircle, Loader2, ImageOff, UploadCloud, FileImage } from 'lucide-react'
import { upsertResourceType, deleteResourceType, uploadResourceTypeImage } from '@/lib/actions/resources'
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

type TypeRow = {
  id: string
  name: string
  description: string | null
  hourlyRate: string
  bufferMinutes: number
  capacity: number | null
  color: string | null
  imageUrl: string | null
  isActive: boolean
}
type Modal = { mode: 'add' } | { mode: 'edit'; row: TypeRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'

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

export function ResourceTypesManager({ currency, types }: { currency: string; types: TypeRow[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

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
        <StatCard icon={Boxes} label="Total types" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="Active" value={stats.active} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} accent="bg-muted text-muted-foreground" />
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
                <th className="px-4 py-3 font-medium">Rate</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {types.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No resource types yet. Add one to get started.
                  </td>
                </tr>
              )}
              {types.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Thumb imageUrl={row.imageUrl} />
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
                  <td className="px-4 py-3 text-muted-foreground">{formatMoney(row.hourlyRate, currency)}/hr</td>
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

/** Name/rate/capacity/description block shared by the modal's live preview. */
function TypeCardBody({
  name,
  rate,
  currency,
  capacity,
  bufferMinutes,
  description,
}: {
  name: string
  rate: number | string
  currency: string
  capacity?: number | null
  bufferMinutes?: number
  description?: string | null
}) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 text-base font-semibold">{name || 'Untitled type'}</h3>
        <span className="shrink-0 text-base font-semibold text-primary">{formatMoney(rate, currency)}/hr</span>
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
  pending,
  run,
  onClose,
}: {
  row?: TypeRow
  currency: string
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [rate, setRate] = useState(row?.hourlyRate ?? '')
  const [buffer, setBuffer] = useState(String(row?.bufferMinutes ?? 0))
  const [capacity, setCapacity] = useState(row?.capacity ? String(row.capacity) : '')
  const [color, setColor] = useState(row?.color ?? '')
  const [isActive, setIsActive] = useState(row?.isActive ?? true)
  const [imageUrl, setImageUrl] = useState(row?.imageUrl ?? '')
  const [fileName, setFileName] = useState<string | null>(row?.imageUrl ? fileNameFromUrl(row.imageUrl) : null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const errors = useMemo(() => {
    const e: { name?: string; description?: string; rate?: string; buffer?: string; capacity?: string } = {}
    if (!name.trim()) e.name = 'Name is required.'
    else if (name.trim().length < 2) e.name = 'Name must be at least 2 characters.'
    if (description.trim() && description.trim().length < 5) e.description = 'Description must be at least 5 characters.'
    if (rate !== '' && Number.isNaN(Number(rate))) e.rate = 'Enter a valid rate.'
    if (buffer !== '' && (Number.isNaN(Number(buffer)) || !Number.isInteger(Number(buffer))))
      e.buffer = 'Buffer must be a whole number.'
    if (capacity !== '' && (Number.isNaN(Number(capacity)) || Number(capacity) <= 0))
      e.capacity = 'Capacity must be a positive number.'
    return e
  }, [name, description, rate, buffer, capacity])
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
          bufferMinutes: buffer === '' ? 0 : Number(buffer),
          capacity: capacity === '' ? undefined : Number(capacity),
          color,
          imageUrl,
          isActive,
        }),
      () => {
        toast.success(row ? `Resource type "${name.trim()}" updated.` : `Resource type "${name.trim()}" added.`)
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
          <h2 className="text-xl font-semibold">{row ? 'Edit resource type' : 'Add resource type'}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Fill in the details — the preview updates as you type.</p>

          <div className="mt-4 space-y-3">
            {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}

            <div>
              <label className={label}>
                Name <span className="text-destructive">*</span>
              </label>
              <input
                className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
                placeholder="e.g. PS5 Station"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
            </div>
            <div>
              <label className={label}>Description (optional)</label>
              <textarea
                className={`${input} ${submitted && errors.description ? inputInvalid : ''}`}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              {submitted && errors.description && <p className={errorText}>{errors.description}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Hourly rate</label>
                <input
                  className={`${input} ${submitted && errors.rate ? inputInvalid : ''}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
                {submitted && errors.rate && <p className={errorText}>{errors.rate}</p>}
              </div>
              <div>
                <label className={label}>Buffer (minutes)</label>
                <input
                  className={`${input} ${submitted && errors.buffer ? inputInvalid : ''}`}
                  type="number"
                  min="0"
                  value={buffer}
                  onChange={(e) => setBuffer(e.target.value)}
                />
                {submitted && errors.buffer && <p className={errorText}>{errors.buffer}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Capacity (optional)</label>
                <input
                  className={`${input} ${submitted && errors.capacity ? inputInvalid : ''}`}
                  type="number"
                  min="1"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                />
                {submitted && errors.capacity && <p className={errorText}>{errors.capacity}</p>}
              </div>
              <div>
                <label className={label}>Calendar color (optional)</label>
                <input className={input} placeholder="#3b82f6" value={color} onChange={(e) => setColor(e.target.value)} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
            <div>
              <label className={label}>Photo</label>
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
              <TypeVisual imageUrl={imageUrl} isActive={isActive} />
            </div>
            <TypeCardBody
              name={name}
              rate={rate === '' ? 0 : Number(rate)}
              currency={currency}
              capacity={capacity === '' ? null : Number(capacity)}
              bufferMinutes={buffer === '' ? 0 : Number(buffer)}
              description={description}
            />
          </div>

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
              {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Resource Type'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
