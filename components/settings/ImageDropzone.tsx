'use client'

import { Loader2 } from 'lucide-react'

/**
 * The dashed "click to upload an image" drop target shared by the settings
 * screens (website ImageUploadField, the setup photo strip). Purely
 * presentational: it owns the styling, the hidden file input and the
 * uploading state; the caller owns what is uploaded and where it goes.
 *
 * `children` is the idle content (icon + label); while `uploading` it is
 * replaced by a spinner and `uploadingLabel`.
 */
export function ImageDropzone({
  uploading = false,
  disabled = false,
  multiple = false,
  compact = false,
  uploadingLabel = 'Uploading…',
  ariaLabel,
  onFiles,
  children,
}: {
  uploading?: boolean
  disabled?: boolean
  multiple?: boolean
  /** Square, tight variant for a slot in a photo strip. */
  compact?: boolean
  uploadingLabel?: string
  ariaLabel?: string
  onFiles: (files: File[]) => void
  children: React.ReactNode
}) {
  const blocked = uploading || disabled
  return (
    <label
      className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-center transition focus-within:ring-2 focus-within:ring-ring/40 ${
        compact ? 'aspect-square px-1.5 py-2' : 'mt-1 px-4 py-5'
      } ${
        blocked
          ? 'cursor-not-allowed border-border opacity-60'
          : 'cursor-pointer border-border hover:border-primary/50 hover:bg-muted/30'
      }`}
    >
      {uploading ? (
        <>
          <Loader2 size={compact ? 16 : 20} className="animate-spin text-muted-foreground" />
          <span className={compact ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>
            {uploadingLabel}
          </span>
        </>
      ) : (
        children
      )}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="sr-only"
        multiple={multiple}
        disabled={blocked}
        aria-label={ariaLabel}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
    </label>
  )
}
