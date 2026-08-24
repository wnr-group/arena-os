'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Plus,
  Pencil,
  Trash2,
  GripVertical,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  CircleDashed,
} from 'lucide-react'
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { reorderWebsiteSections, deleteWebsiteSection, updateWebsiteBranding, publishWebsite } from '@/lib/actions/website'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { SectionModal, SECTION_TYPES, type SectionRow } from './SectionModal'
import { ImageUploadField } from './ImageUploadField'
import type { WebsiteSectionType } from '@/lib/website/types'

type Branding = { logoUrl: string | null; accentColor: string | null; heroImageUrl: string | null }
type PublishStatus = 'unpublished' | 'live' | 'changed'
type Modal = { mode: 'add'; type: WebsiteSectionType } | { mode: 'edit'; section: SectionRow } | null

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/
const DEFAULT_ACCENT = '#7c3aed'

export function WebsiteEditor({
  sections,
  settings,
  publishStatus,
  publishedAt,
}: {
  sections: SectionRow[]
  settings: Branding | null
  publishStatus: PublishStatus
  publishedAt: string | null
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [items, setItems] = useState(sections)
  const [modal, setModal] = useState<Modal>(null)
  const [typePicker, setTypePicker] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [, startReorder] = useTransition()

  useEffect(() => setItems(sections), [sections])

  // Keyboard sensor makes the list reorderable without a mouse/touch drag —
  // Tab to a handle, Space to pick it up, arrow keys to move it, Space again
  // to drop (dnd-kit's standard sortable keyboard interaction).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems((prev) => {
      const oldIndex = prev.findIndex((s) => s.id === active.id)
      const newIndex = prev.findIndex((s) => s.id === over.id)
      const next = arrayMove(prev, oldIndex, newIndex)
      startReorder(async () => {
        const r = await reorderWebsiteSections(next.map((s) => s.id))
        if (r.error) {
          toast.error(r.error)
          router.refresh()
        }
      })
      return next
    })
  }

  async function handleDelete(row: SectionRow) {
    const label = row.heading || SECTION_TYPES.find((t) => t.type === row.type)?.label || 'section'
    await confirm({
      title: `Delete "${label}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteWebsiteSection(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          toast.success(`"${label}" deleted.`)
          router.refresh()
        }
      },
    })
  }

  async function handlePublish() {
    setPublishing(true)
    const r = await publishWebsite()
    setPublishing(false)
    if (r.error) {
      toast.error(r.error)
    } else {
      toast.success('Website published — it is now live.')
      router.refresh()
    }
  }

  return (
    <div className="mt-8 space-y-8">
      <PublishBar status={publishStatus} publishedAt={publishedAt} publishing={publishing} onPublish={handlePublish} />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
            Sections {items.length > 0 && <span className="text-muted-foreground/60">({items.length})</span>}
          </h2>
          <div className="relative">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-primary-foreground shadow-sm transition hover:shadow-md"
              onClick={() => setTypePicker((v) => !v)}
            >
              <Plus size={16} /> Add Section
            </button>
            {typePicker && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setTypePicker(false)} />
                <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-border bg-card p-2 shadow-2xl">
                  {SECTION_TYPES.map(({ type, label, description, icon: Icon }) => (
                    <button
                      key={type}
                      className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-muted"
                      onClick={() => {
                        setTypePicker(false)
                        setModal({ mode: 'add', type })
                      }}
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon size={16} />
                      </span>
                      <span>
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block text-xs text-muted-foreground">{description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-base text-muted-foreground">
            No sections yet. Add one to start building your homepage.
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {items.map((row) => (
                  <SectionCard
                    key={row.id}
                    row={row}
                    deleting={deletingId === row.id}
                    onEdit={() => setModal({ mode: 'edit', section: row })}
                    onDelete={() => handleDelete(row)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <BrandingPanel settings={settings} />

      {modal?.mode === 'add' && <SectionModal mode="add" type={modal.type} onClose={() => setModal(null)} />}
      {modal?.mode === 'edit' && <SectionModal mode="edit" section={modal.section} onClose={() => setModal(null)} />}
    </div>
  )
}

function SectionCard({
  row,
  deleting,
  onEdit,
  onDelete,
}: {
  row: SectionRow
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const meta = SECTION_TYPES.find((t) => t.type === row.type)
  const Icon = meta?.icon ?? CircleDashed

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm transition ${isDragging ? 'opacity-60 shadow-lg' : ''}`}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={18} />
      </button>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.heading || meta?.label || row.type}</p>
        <p className="text-xs text-muted-foreground">{meta?.label}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          className="rounded-lg px-3 py-2 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
          disabled={deleting}
          onClick={onEdit}
          aria-label="Edit"
        >
          <Pencil size={16} />
        </button>
        <button
          className="rounded-lg px-3 py-2 text-muted-foreground transition hover:bg-muted hover:text-destructive disabled:opacity-50"
          disabled={deleting}
          onClick={onDelete}
          aria-label="Delete"
        >
          {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
        </button>
      </div>
    </div>
  )
}

function PublishBar({
  status,
  publishedAt,
  publishing,
  onPublish,
}: {
  status: PublishStatus
  publishedAt: string | null
  publishing: boolean
  onPublish: () => void
}) {
  const badge = {
    unpublished: { icon: CircleDashed, text: 'Not published yet', cls: 'bg-muted text-muted-foreground' },
    changed: { icon: AlertCircle, text: 'Unpublished changes', cls: 'bg-amber-500/10 text-amber-600' },
    live: { icon: CheckCircle2, text: 'Live', cls: 'bg-emerald-500/10 text-emerald-600' },
  }[status]
  const Badge = badge.icon

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium ${badge.cls}`}>
          <Badge size={14} /> {badge.text}
        </span>
        {publishedAt && <span className="text-xs text-muted-foreground">Last published {new Date(publishedAt).toLocaleString()}</span>}
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/settings/website/preview"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-foreground transition hover:bg-muted"
        >
          Preview <ExternalLink size={14} />
        </Link>
        <button
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          disabled={publishing}
          onClick={onPublish}
        >
          {publishing && <Loader2 size={15} className="animate-spin" />}
          {publishing ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </div>
  )
}

function BrandingPanel({ settings }: { settings: Branding | null }) {
  const [logoUrl, setLogoUrl] = useState(settings?.logoUrl ?? '')
  const [heroImageUrl, setHeroImageUrl] = useState(settings?.heroImageUrl ?? '')
  const [accentColor, setAccentColor] = useState(settings?.accentColor ?? DEFAULT_ACCENT)
  const [pending, setPending] = useState(false)

  const accentValid = HEX_PATTERN.test(accentColor)

  async function save() {
    if (!accentValid) {
      toast.error('Accent colour must be a hex value like #7c3aed.')
      return
    }
    setPending(true)
    const r = await updateWebsiteBranding({
      logoUrl: logoUrl || null,
      accentColor: accentColor || null,
      heroImageUrl: heroImageUrl || null,
    })
    setPending(false)
    if (r.error) toast.error(r.error)
    else toast.success('Branding saved.')
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">Branding</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ImageUploadField label="Logo" value={logoUrl} onChange={setLogoUrl} hint="Square works best · up to 5MB" />
        <ImageUploadField label="Hero image" value={heroImageUrl} onChange={setHeroImageUrl} hint="Wide banner · up to 5MB" />
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground">Accent colour</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="color"
            value={accentValid ? accentColor : DEFAULT_ACCENT}
            onChange={(e) => setAccentColor(e.target.value)}
            className="size-10 shrink-0 cursor-pointer rounded-lg border border-border bg-background p-1"
          />
          <input
            className={`w-40 rounded-lg border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:ring-2 focus:ring-ring/30 ${
              accentColor && !accentValid ? 'border-destructive focus:border-destructive' : 'border-border focus:border-primary'
            }`}
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            placeholder="#7c3aed"
            maxLength={7}
          />
        </div>
        {accentColor && !accentValid && <p className="mt-1 text-sm text-destructive">Must be a hex colour like #7c3aed.</p>}
      </div>
      <button
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
        disabled={pending}
        onClick={save}
      >
        {pending && <Loader2 size={15} className="animate-spin" />}
        {pending ? 'Saving…' : 'Save Branding'}
      </button>
    </div>
  )
}
