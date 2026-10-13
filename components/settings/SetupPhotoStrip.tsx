'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { uploadSetupImage, removeSetupImage, reorderSetupImages } from '@/lib/actions/resources'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { checkPhotoFile, movePhoto, planUploads, SETUP_PHOTO_MAX } from '@/lib/booking/setup-photo-ui'
import { ImageDropzone } from './ImageDropzone'

export type SetupPhotoItem = { id: string; url: string }

type UploadError = { name: string; message: string }

const iconBtn =
  'flex size-6 shrink-0 items-center justify-center rounded-md bg-background/90 sm:size-7 text-foreground shadow-sm ring-1 ring-border transition hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40'

/**
 * M35 #9: a setup's photo manager — three slots, position 1 is the cover.
 * Optimistic (uploads append, remove/move apply at once) but always reconciled
 * with the server (router.refresh()), and a failed remove/reorder reverts.
 * Every mutation goes through the manager-only actions (#8), which re-check
 * the role, industry, tenant and the 3-photo cap; nothing here is trusted.
 *
 * `setupId` null = a setup that hasn't been saved yet: photos need an id, so
 * the strip is shown disabled with a hint instead of hiding the feature.
 */
export function SetupPhotoStrip({
  setupId,
  setupName,
  photos,
}: {
  setupId: string | null
  setupName: string
  photos: SetupPhotoItem[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [list, setList] = useState<SetupPhotoItem[]>(photos)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(0)
  const [errors, setErrors] = useState<UploadError[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  // Follow the server whenever its photo set changes (after refresh, or an
  // edit elsewhere) — but never clobber an optimistic change mid-flight.
  const serverKey = photos.map((p) => p.id).join(',')
  useEffect(() => {
    if (!busy) setList(photos)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  const addError = (name: string, message: string) => setErrors((prev) => [...prev, { name, message }])

  async function onFiles(files: File[]) {
    if (!setupId || busy) return
    const { accepted, skipped } = planUploads(list.length, files)
    setErrors([])
    setNotice(
      skipped > 0
        ? `A setup holds up to ${SETUP_PHOTO_MAX} photos — ${skipped} extra file${skipped === 1 ? ' was' : 's were'} ignored.`
        : null,
    )
    if (accepted.length === 0) return
    setBusy(true)
    setQueued(accepted.length)
    // One file per request (the action's body limit is 6 MB), strictly in order.
    for (const file of accepted) {
      const bad = checkPhotoFile(file)
      if (bad) {
        addError(file.name, bad)
      } else {
        try {
          const fd = new FormData()
          fd.set('file', file)
          const r = await uploadSetupImage(setupId, fd)
          if (r.error || !r.id || !r.url) addError(file.name, r.error ?? 'Upload failed. Please try again.')
          else setList((prev) => [...prev, { id: r.id!, url: r.url! }])
        } catch {
          addError(file.name, 'Upload failed. Check your connection and try again.')
        }
      }
      setQueued((q) => q - 1)
    }
    setBusy(false)
    router.refresh()
  }

  async function onRemove(index: number) {
    if (!setupId || busy) return
    const photo = list[index]
    const ok = await confirm({
      title: `Remove photo ${index + 1}?`,
      description: index === 0 ? 'This is the cover photo. The next photo becomes the cover.' : 'The photo is deleted from this setup.',
      confirmText: 'Remove',
    })
    if (!ok) return
    const previous = list
    setErrors([])
    setNotice(null)
    setBusy(true)
    setList(list.filter((p) => p.id !== photo.id))
    try {
      const r = await removeSetupImage(photo.id)
      if (r.error) {
        setList(previous)
        addError(`Photo ${index + 1}`, r.error)
      }
    } catch {
      setList(previous)
      addError(`Photo ${index + 1}`, 'Could not remove the photo. Check your connection and try again.')
    }
    setBusy(false)
    router.refresh()
  }

  async function onMove(index: number, direction: -1 | 1) {
    if (!setupId || busy) return
    const next = movePhoto(list, index, direction)
    if (!next) return
    const previous = list
    setErrors([])
    setNotice(null)
    setBusy(true)
    setList(next)
    try {
      const r = await reorderSetupImages(setupId, next.map((p) => p.id))
      if (r.error) {
        setList(previous)
        addError(`Photo ${index + 1}`, r.error)
      }
    } catch {
      setList(previous)
      addError(`Photo ${index + 1}`, 'Could not reorder the photos. Check your connection and try again.')
    }
    setBusy(false)
    router.refresh()
  }

  const slots = Array.from({ length: SETUP_PHOTO_MAX }, (_, i) => i)
  const full = list.length >= SETUP_PHOTO_MAX

  return (
    <div className="mt-2.5 border-t border-border/60 pt-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Photos</p>
        <p className="text-xs text-muted-foreground">
          {list.length}/{SETUP_PHOTO_MAX}
        </p>
      </div>

      <ul className="mt-1.5 grid grid-cols-3 gap-2">
        {slots.map((i) => {
          const photo = list[i]
          const uploadingHere = !photo && i < list.length + queued
          return (
            <li key={i} className="min-w-0">
              {photo ? (
                <div className="relative aspect-square overflow-hidden rounded-lg border border-border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt={`${setupName} photo ${i + 1}${i === 0 ? ' (cover)' : ''}`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                  {i === 0 && (
                    <span className="absolute left-1 top-1 rounded bg-primary px-1 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                      Cover
                    </span>
                  )}
                  <button
                    type="button"
                    className={`${iconBtn} absolute right-1 top-1 text-destructive`}
                    disabled={busy}
                    onClick={() => onRemove(i)}
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    <Trash2 size={14} />
                  </button>
                  <div className="absolute bottom-1 left-1 flex gap-1">
                    <button
                      type="button"
                      className={iconBtn}
                      disabled={busy || i === 0}
                      onClick={() => onMove(i, -1)}
                      aria-label={`Move photo ${i + 1} left`}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      type="button"
                      className={iconBtn}
                      disabled={busy || i === list.length - 1}
                      onClick={() => onMove(i, 1)}
                      aria-label={`Move photo ${i + 1} right`}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              ) : uploadingHere ? (
                <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border bg-muted/30 text-center">
                  <Loader2 size={16} className={i === list.length ? 'animate-spin text-muted-foreground' : 'text-muted-foreground/50'} />
                  <span className="text-xs text-muted-foreground">{i === list.length ? 'Uploading…' : 'Queued'}</span>
                </div>
              ) : (
                <ImageDropzone
                  compact
                  multiple
                  disabled={!setupId || busy || full}
                  ariaLabel={`Add photo to ${setupName}`}
                  onFiles={onFiles}
                >
                  <ImagePlus size={16} className="text-muted-foreground" />
                  <span className="text-xs font-medium leading-tight">+ Add photo</span>
                </ImageDropzone>
              )}
            </li>
          )
        })}
      </ul>

      {!setupId && <p className="mt-1.5 text-xs text-muted-foreground">Save the setup first, then add photos.</p>}
      {setupId && !full && list.length === 0 && queued === 0 && errors.length === 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          JPEG, PNG, WEBP or GIF, up to 5MB each. The first photo is the cover shown on the booking page.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="mt-1.5 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i} className="text-xs text-destructive">
              <span className="font-medium">{e.name}:</span> {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
