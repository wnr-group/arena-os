'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import {
  createCustomerNote,
  updateCustomerNote,
  deleteCustomerNote,
} from '@/lib/actions/customers'
import { MAX_NOTE_LENGTH } from '@/lib/customers/note-body'

export type NoteRow = {
  id: string
  body: string
  authorName: string | null
  createdLabel: string
  editedLabel: string | null
}

const textarea =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

export function CustomerNotes({
  customerId,
  notes,
  canManage,
}: {
  customerId: string
  notes: NoteRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const composer = useRef<HTMLTextAreaElement>(null)

  /** Shared submit path — mirrors ResourcesManager's run(). */
  function run(fn: () => Promise<{ error?: string }>, done: string, after?: () => void) {
    setError(null)
    setNotice(null)
    start(async () => {
      const r = await fn()
      if (r.error) {
        setError(r.error)
        return
      }
      setNotice(done)
      after?.()
      router.refresh()
    })
  }

  function removeNote(id: string) {
    if (!confirm('Delete this note? This cannot be undone.')) return
    run(() => deleteCustomerNote(id), 'Note deleted.')
  }

  return (
    <div>
      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mb-3 rounded-md border px-3 py-2 text-sm text-muted-foreground">{notice}</p>
      )}

      {notes.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No notes about this customer yet.
            {canManage && ' Jot down what the team should know before they arrive.'}
          </p>
          {canManage && (
            <button
              type="button"
              onClick={() => composer.current?.focus()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <MessageSquarePlus size={16} /> Add the first note
            </button>
          )}
        </div>
      ) : (
        <ul className={`space-y-2 transition-opacity ${pending ? 'opacity-60' : ''}`}>
          {notes.map((n) => (
            <NoteItem key={n.id} note={n} canManage={canManage} pending={pending} run={run} onDelete={removeNote} />
          ))}
        </ul>
      )}

      {canManage && <NoteComposer ref={composer} customerId={customerId} pending={pending} run={run} />}
    </div>
  )
}

type Run = (fn: () => Promise<{ error?: string }>, done: string, after?: () => void) => void

function NoteItem({
  note,
  canManage,
  pending,
  run,
  onDelete,
}: {
  note: NoteRow
  canManage: boolean
  pending: boolean
  run: Run
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(note.body)

  function save() {
    run(
      () => updateCustomerNote({ noteId: note.id, body }),
      'Note updated.',
      () => setEditing(false),
    )
  }

  return (
    <li className="rounded-lg border p-3">
      {editing ? (
        <>
          <textarea
            className={textarea}
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Edit note"
            autoFocus
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className={`${btn} border`}
              onClick={() => {
                setBody(note.body)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${btn} bg-primary text-primary-foreground`}
              disabled={pending || !body.trim() || body.trim() === note.body}
              onClick={save}
            >
              {pending ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 whitespace-pre-wrap text-sm">{note.body}</p>
            {canManage && (
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  disabled={pending}
                  onClick={() => setEditing(true)}
                  aria-label="Edit note"
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  className="p-1 text-destructive hover:opacity-80 disabled:opacity-50"
                  disabled={pending}
                  onClick={() => onDelete(note.id)}
                  aria-label="Delete note"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {note.createdLabel}
            {' · '}
            {note.authorName ?? 'Former team member'}
            {note.editedLabel && ` · edited ${note.editedLabel}`}
          </p>
        </>
      )}
    </li>
  )
}

function NoteComposer({
  ref,
  customerId,
  pending,
  run,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>
  customerId: string
  pending: boolean
  run: Run
}) {
  const [body, setBody] = useState('')

  function submit() {
    run(
      () => createCustomerNote({ customerId, body }),
      'Note added.',
      () => setBody(''),
    )
  }

  return (
    <form
      className="mt-3 rounded-md border border-dashed p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label htmlFor="new-note" className="text-xs font-medium text-muted-foreground">
        Add a note
      </label>
      <textarea
        id="new-note"
        ref={ref}
        className={`${textarea} mt-1`}
        rows={2}
        maxLength={MAX_NOTE_LENGTH}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="e.g. Prefers the corner booth. Allergic to peanuts."
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {body.length > MAX_NOTE_LENGTH - 200 && `${MAX_NOTE_LENGTH - body.length} characters left`}
        </span>
        <button
          type="submit"
          className={`${btn} bg-primary text-primary-foreground`}
          disabled={pending || !body.trim()}
        >
          {pending ? 'Saving…' : 'Add note'}
        </button>
      </div>
    </form>
  )
}
