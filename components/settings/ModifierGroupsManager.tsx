'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Loader2, Layers } from 'lucide-react'
import {
  upsertModifierGroup,
  deleteModifierGroup,
  upsertModifierOption,
  deleteModifierOption,
} from '@/lib/actions/modifiers'
import { formatMoney } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'

export type ModifierOptionRow = { id: string; name: string; priceDelta: string; sortOrder: number }
export type ModifierGroupRow = {
  id: string
  name: string
  minSelect: number
  maxSelect: number
  required: boolean
  sortOrder: number
  options: ModifierOptionRow[]
}

type GroupModal = { mode: 'add' } | { mode: 'edit'; row: ModifierGroupRow }
type OptionModal = { mode: 'add'; groupId: string } | { mode: 'edit'; groupId: string; row: ModifierOptionRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void, onSettled?: () => void) => void

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'
const NAME_PATTERN = /^[\p{L}\p{N} &'.,()-]+$/u

/** "Choose exactly 1", "Choose up to 3", "Choose 1–3" — the plain-English
 *  summary of a group's min/max, shown wherever the raw numbers would
 *  otherwise need explaining. */
function selectSummary(minSelect: number, maxSelect: number): string {
  if (minSelect === maxSelect) return `Choose exactly ${minSelect}`
  if (minSelect === 0) return `Choose up to ${maxSelect}`
  return `Choose ${minSelect}–${maxSelect}`
}

export function ModifierGroupsManager({ currency, groups }: { currency: string; groups: ModifierGroupRow[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [groupModal, setGroupModal] = useState<GroupModal | null>(null)
  const [optionModal, setOptionModal] = useState<OptionModal | null>(null)
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null)
  const [deletingOptionId, setDeletingOptionId] = useState<string | null>(null)

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

  async function handleDeleteGroup(row: ModifierGroupRow) {
    await confirm({
      title: `Delete "${row.name}"?`,
      description:
        row.options.length > 0
          ? `This also deletes its ${row.options.length} option${row.options.length === 1 ? '' : 's'}, and detaches it from every item that offers it. This cannot be undone.`
          : 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingGroupId(row.id)
        const r = await deleteModifierGroup(row.id)
        setDeletingGroupId(null)
        if (r.error) toast.error(r.error)
        else {
          router.refresh()
          toast.success(`"${row.name}" deleted.`)
        }
      },
    })
  }

  async function handleDeleteOption(groupName: string, row: ModifierOptionRow) {
    await confirm({
      title: `Delete "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingOptionId(row.id)
        const r = await deleteModifierOption(row.id)
        setDeletingOptionId(null)
        if (r.error) toast.error(r.error)
        else {
          router.refresh()
          toast.success(`"${row.name}" removed from "${groupName}".`)
        }
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
          All groups {groups.length > 0 && <span className="text-muted-foreground/60">({groups.length})</span>}
        </h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          onClick={() => setGroupModal({ mode: 'add' })}
        >
          <Plus size={16} /> Add Group
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-base text-muted-foreground">
          No modifier groups yet. Add one — e.g. &ldquo;Size&rdquo; or &ldquo;Add-ons&rdquo; — then attach it to menu items in{' '}
          <span className="font-medium text-foreground">Menu → Items</span>.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.id} className="rounded-xl border border-border bg-card shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Layers size={16} />
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{group.name}</h3>
                      {group.required && (
                        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                          Required
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {selectSummary(group.minSelect, group.maxSelect)} · {group.options.length} option
                      {group.options.length === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    className={btn}
                    disabled={pending}
                    onClick={() => setGroupModal({ mode: 'edit', row: group })}
                    aria-label={`Edit ${group.name}`}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className={`${btn} text-destructive`}
                    disabled={pending}
                    onClick={() => handleDeleteGroup(group)}
                    aria-label={`Delete ${group.name}`}
                  >
                    {deletingGroupId === group.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  </button>
                </div>
              </div>

              <div className="space-y-2 p-4">
                {group.options.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No options yet.</p>
                ) : (
                  group.options.map((opt) => (
                    <div key={opt.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                      <span className="text-sm font-medium">{opt.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">
                          {Number(opt.priceDelta) === 0 ? 'No charge' : `+${formatMoney(opt.priceDelta, currency)}`}
                        </span>
                        <button
                          className="text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={pending}
                          onClick={() => setOptionModal({ mode: 'edit', groupId: group.id, row: opt })}
                          aria-label={`Edit ${opt.name}`}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="text-muted-foreground transition hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={pending}
                          onClick={() => handleDeleteOption(group.name, opt)}
                          aria-label={`Delete ${opt.name}`}
                        >
                          {deletingOptionId === opt.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    </div>
                  ))
                )}
                <button
                  type="button"
                  onClick={() => setOptionModal({ mode: 'add', groupId: group.id })}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  <Plus size={14} /> Add option
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {groupModal && (
        <GroupModal
          row={groupModal.mode === 'edit' ? groupModal.row : undefined}
          pending={pending}
          run={run}
          onClose={() => setGroupModal(null)}
        />
      )}
      {optionModal && (
        <OptionModal
          groupId={optionModal.groupId}
          row={optionModal.mode === 'edit' ? optionModal.row : undefined}
          pending={pending}
          run={run}
          onClose={() => setOptionModal(null)}
        />
      )}
    </div>
  )
}

function GroupModal({
  row,
  pending,
  run,
  onClose,
}: {
  row?: ModifierGroupRow
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [minSelect, setMinSelect] = useState(String(row?.minSelect ?? 0))
  const [maxSelect, setMaxSelect] = useState(String(row?.maxSelect ?? 1))
  const [required, setRequired] = useState(row?.required ?? false)
  const [submitted, setSubmitted] = useState(false)

  useBodyScrollLock()

  const minNum = Number(minSelect)
  const maxNum = Number(maxSelect)
  const errors: { name?: string; minSelect?: string; maxSelect?: string } = {}
  const trimmedName = name.trim()
  if (!trimmedName) errors.name = 'Name is required.'
  else if (trimmedName.length < 2) errors.name = 'Name must be at least 2 characters.'
  else if (trimmedName.length > 100) errors.name = 'Name must be at most 100 characters.'
  else if (!NAME_PATTERN.test(trimmedName)) errors.name = "Name can only contain letters, numbers, spaces, and & - ' . , ( )"
  if (minSelect === '' || Number.isNaN(minNum) || !Number.isInteger(minNum) || minNum < 0) {
    errors.minSelect = 'Min must be a whole number of zero or more.'
  }
  if (maxSelect === '' || Number.isNaN(maxNum) || !Number.isInteger(maxNum) || maxNum < 1) {
    errors.maxSelect = 'Max must be a whole number of at least 1.'
  }
  if (!errors.minSelect && !errors.maxSelect && maxNum < minNum) {
    errors.maxSelect = 'Max must be at least min.'
  }
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () =>
        upsertModifierGroup({
          id: row?.id,
          name: trimmedName,
          minSelect: minNum,
          maxSelect: maxNum,
          required,
          sortOrder: row?.sortOrder ?? 0,
        }),
      () => {
        toast.success(row ? `"${trimmedName}" updated.` : `"${trimmedName}" added.`)
        onClose()
      },
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Edit group' : 'Add group'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>
              Name <span className="text-destructive">*</span>
            </label>
            <input
              className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
              placeholder="e.g. Size, Add-ons, Spice Level"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
            {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Min selectable</label>
              <input
                className={`${input} ${submitted && errors.minSelect ? inputInvalid : ''}`}
                type="number"
                min={0}
                value={minSelect}
                onChange={(e) => setMinSelect(e.target.value)}
              />
              {submitted && errors.minSelect && <p className={errorText}>{errors.minSelect}</p>}
            </div>
            <div>
              <label className={label}>Max selectable</label>
              <input
                className={`${input} ${submitted && errors.maxSelect ? inputInvalid : ''}`}
                type="number"
                min={1}
                value={maxSelect}
                onChange={(e) => setMaxSelect(e.target.value)}
              />
              {submitted && errors.maxSelect && <p className={errorText}>{errors.maxSelect}</p>}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {!errors.minSelect && !errors.maxSelect ? selectSummary(minNum, maxNum) : 'e.g. min 1, max 1 for "choose exactly one size."'}
          </p>
          <label className="flex items-center gap-2 text-base">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            Required — a waiter or guest must choose before adding this item
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Group'}
          </button>
        </div>
      </div>
    </div>
  )
}

function OptionModal({
  groupId,
  row,
  pending,
  run,
  onClose,
}: {
  groupId: string
  row?: ModifierOptionRow
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [priceDelta, setPriceDelta] = useState(row?.priceDelta ?? '0')
  const [submitted, setSubmitted] = useState(false)

  useBodyScrollLock()

  const priceNum = Number(priceDelta)
  const errors: { name?: string; priceDelta?: string } = {}
  const trimmedName = name.trim()
  if (!trimmedName) errors.name = 'Name is required.'
  else if (trimmedName.length > 100) errors.name = 'Name must be at most 100 characters.'
  if (priceDelta === '' || Number.isNaN(priceNum)) errors.priceDelta = 'Enter a valid price.'
  else if (priceNum < 0) errors.priceDelta = "Price can't be negative."
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () => upsertModifierOption({ id: row?.id, groupId, name: trimmedName, priceDelta: priceNum, sortOrder: row?.sortOrder ?? 0 }),
      () => {
        toast.success(row ? `"${trimmedName}" updated.` : `"${trimmedName}" added.`)
        onClose()
      },
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Edit option' : 'Add option'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>
              Name <span className="text-destructive">*</span>
            </label>
            <input
              className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
              placeholder="e.g. Large, Extra cheese, No onions"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
            {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
          </div>
          <div>
            <label className={label}>Price delta</label>
            <input
              className={`${input} ${submitted && errors.priceDelta ? inputInvalid : ''}`}
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={priceDelta}
              onChange={(e) => setPriceDelta(e.target.value)}
            />
            {submitted && errors.priceDelta ? (
              <p className={errorText}>{errors.priceDelta}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">0 for a free choice like &ldquo;No onions.&rdquo;</p>
            )}
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Option'}
          </button>
        </div>
      </div>
    </div>
  )
}
