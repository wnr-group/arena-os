'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'
import { updateCustomerTags } from '@/lib/actions/customers'
import { hasTag, normalizeTag, MAX_TAGS } from '@/lib/customers/tags'

const chip = 'rounded-full bg-muted px-2 py-0.5 text-xs'

export function CustomerTags({
  customerId,
  tags: initialTags,
  canManage,
}: {
  customerId: string
  tags: string[]
  canManage: boolean
}) {
  const router = useRouter()
  const [tags, setTags] = useState(initialTags)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [removingTag, setRemovingTag] = useState<string | null>(null)

  // Adopt the server's list when the profile re-renders from outside this
  // component (a refresh, the back button), the same way CustomersView keeps its
  // search box in step with the URL.
  const applied = useRef(initialTags)
  useEffect(() => {
    if (applied.current !== initialTags) {
      applied.current = initialTags
      setTags(initialTags)
    }
  }, [initialTags])

  function save(next: string[], after?: () => void, onSettled?: () => void) {
    setError(null)
    start(async () => {
      const r = await updateCustomerTags({ customerId, tags: next })
      if (r.error || !r.tags) {
        setError(r.error ?? 'Could not save the tags.')
        onSettled?.()
        return
      }
      applied.current = r.tags
      setTags(r.tags)
      after?.()
      router.refresh()
      onSettled?.()
    })
  }

  function add() {
    const tag = normalizeTag(draft)
    if (!tag) return
    if (hasTag(tags, tag)) {
      setError(`“${tag}” is already tagged.`)
      return
    }
    if (tags.length >= MAX_TAGS) {
      setError(`A customer can have at most ${MAX_TAGS} tags.`)
      return
    }
    save([...tags, tag], () => setDraft(''))
  }

  function remove(tag: string) {
    setRemovingTag(tag)
    save(
      tags.filter((t) => t !== tag),
      undefined,
      () => setRemovingTag(null),
    )
  }

  if (!canManage) {
    if (tags.length === 0) return null
    return (
      <div className="mt-2 flex flex-wrap gap-1">
        {tags.map((t) => (
          <span key={t} className={chip}>
            {t}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className={`mt-2 ${pending ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-1">
        {tags.length === 0 && !adding && (
          <span className="text-xs text-muted-foreground">No tags yet</span>
        )}

        {tags.map((t) => (
          <span key={t} className={`${chip} inline-flex items-center gap-1`}>
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              disabled={pending}
              aria-label={`Remove tag ${t}`}
              className="text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              {removingTag === t ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            </button>
          </span>
        ))}

        {adding ? (
          <span className="inline-flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
                if (e.key === 'Escape') {
                  setAdding(false)
                  setDraft('')
                  setError(null)
                }
              }}
              placeholder="New tag"
              aria-label="New tag"
              autoFocus
              className="w-32 rounded-full border bg-background px-2 py-0.5 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={add}
              disabled={pending || !draft.trim()}
              className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {pending && !removingTag && <Loader2 size={11} className="animate-spin" />}
              {pending && !removingTag ? 'Saving…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setDraft('')
                setError(null)
              }}
              aria-label="Cancel adding a tag"
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={13} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setAdding(true)
            }}
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus size={11} /> Add tag
          </button>
        )}
      </div>

      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  )
}
