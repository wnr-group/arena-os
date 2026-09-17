'use client'

import { useState } from 'react'
import { Loader2, FileImage, UploadCloud } from 'lucide-react'
import { uploadWebsiteImage } from '@/lib/actions/website'

function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(url.split('/').pop() || url)
  } catch {
    return url
  }
}

/** Same upload-widget shape as components/settings/MenuItemsManager.tsx, shared
 *  here since section images, logo, and hero image all need the identical
 *  upload/replace/remove flow. */
export function ImageUploadField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (url: string) => void
  hint?: string
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileName = value ? fileNameFromUrl(value) : null

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    const r = await uploadWebsiteImage(fd)
    setUploading(false)
    if (r.error) setError(r.error)
    else if (r.url) onChange(r.url)
  }

  return (
    <div>
      <label className="text-sm font-medium text-muted-foreground">{label}</label>
      <label
        className={`mt-1 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition ${
          uploading ? 'cursor-not-allowed border-border opacity-60' : 'border-border hover:border-primary/50 hover:bg-muted/30'
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
            <span className="text-xs text-muted-foreground">{hint ?? 'JPEG, PNG, WEBP or GIF · up to 5MB'}</span>
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
      {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
      {fileName && !uploading && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground hover:text-destructive"
          onClick={() => onChange('')}
        >
          Remove Image
        </button>
      )}
    </div>
  )
}
