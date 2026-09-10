'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Loader2,
  CalendarDays,
  MapPin,
  Users,
  Trophy,
  ListChecks,
  Gamepad2,
} from 'lucide-react'
import Link from 'next/link'
import { upsertEvent, deleteEvent, setEventStatus, uploadEventBanner } from '@/lib/actions/events'
import {
  EVENT_TRANSITIONS,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  isTerminal,
  validateEventFields,
} from '@/lib/events/lifecycle'
import {
  EVENT_REGISTRATION_MODES,
  EVENT_REGISTRATION_MODE_LABELS,
  type EventRegistrationMode,
} from '@/lib/events/registration'
import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EVENT_STATUS_LABELS,
  TOURNAMENT_FORMATS,
  TOURNAMENT_FORMAT_LABELS,
  requiresTournamentFormat,
  type EventStatus,
  type EventType,
  type TournamentFormat,
} from '@/lib/events/types'
import { formatMoney } from '@/lib/format'
import { formatEventWindow } from '@/lib/events/format'
import type { EventResourceScope } from '@/lib/events/types'
import { ImageUploadField } from '@/components/settings/website/ImageUploadField'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type EventRow = {
  id: string
  branchId: string
  branchName: string | null
  title: string
  type: EventType
  description: string | null
  bannerUrl: string | null
  /** ISO strings — the server component serialises Dates before they cross. */
  startsAt: string
  endsAt: string
  capacity: number | null
  entryFee: string
  tournamentFormat: TournamentFormat | null
  registrationMode: EventRegistrationMode
  teamSize: number | null
  status: EventStatus
  /** M15 #4 — what the event reserves for its window. */
  resourceScope: EventResourceScope
  /** The stations a 'specific'-scope event claims. Empty otherwise. */
  resourceIds: string[]
  /** Live entries — confirmed, checked in, or holding a payment. */
  entrantCount: number
}
type Branch = { id: string; name: string }
type ResourceOption = { id: string; branchId: string; name: string; status: string }
/** Exactly what upsertEvent accepts, derived from the action so the form and
 *  the server schema can never drift apart. */
type EventFormValues = Parameters<typeof upsertEvent>[0]
type Modal = { mode: 'add' } | { mode: 'edit'; row: EventRow }

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const label = 'text-sm font-medium text-muted-foreground'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The statuses that HOLD resources — the client-side mirror of statusBlocks()
 * in lib/events/resource-blocks.ts, which is the authority. Duplicated here
 * only because that module is `server-only` and this list must render without
 * pulling a database driver into the bundle; it decides a LABEL, never access.
 */
const BLOCKING_STATUSES = new Set<EventStatus>([
  'published',
  'registration_open',
  'full',
  'in_progress',
])

const STATUS_CLASS: Record<EventStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  published: 'bg-sky-500/10 text-sky-600',
  registration_open: 'bg-emerald-500/10 text-emerald-600',
  full: 'bg-amber-500/10 text-amber-600',
  in_progress: 'bg-violet-500/10 text-violet-600',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
}

/** `2026-09-02T18:30:00Z` → `2026-09-02T18:30` for datetime-local inputs. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function EventsManager({
  currency,
  timezone,
  branches,
  resources,
  events,
}: {
  currency: string
  timezone: string
  branches: Branch[]
  resources: ResourceOption[]
  events: EventRow[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [modal, setModal] = useState<Modal | null>(null)
  const [pending, startTransition] = useTransition()

  function run(fn: () => Promise<{ error?: string }>, onSuccess?: () => void) {
    startTransition(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        onSuccess?.()
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-6">
      <div className="flex justify-end">
        <button
          type="button"
          className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
          onClick={() => setModal({ mode: 'add' })}
          disabled={branches.length === 0}
        >
          <span className="flex items-center gap-1.5">
            <Plus size={16} /> New Event
          </span>
        </button>
      </div>

      {branches.length === 0 && (
        <p className="mt-4 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          Add an active venue under Settings → Resources before creating events.
        </p>
      )}

      {events.length === 0 ? (
        <p className="mt-8 text-center text-sm text-muted-foreground">No events yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {events.map((e) => (
            <li key={e.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-semibold">{e.title}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[e.status]}`}>
                      {EVENT_STATUS_LABELS[e.status]}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {EVENT_TYPE_LABELS[e.type]}
                    </span>
                  </div>
                  <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <dd className="flex items-center gap-1.5">
                      <CalendarDays size={14} /> {formatEventWindow(e.startsAt, e.endsAt, timezone)}
                    </dd>
                    <dd className="flex items-center gap-1.5">
                      <MapPin size={14} /> {e.branchName ?? '—'}
                    </dd>
                    <dd className="flex items-center gap-1.5">
                      <Users size={14} />
                      {/* Capacity counts ENTRIES: people for a solo event,
                          teams for a team one (migration 0091). */}
                      {e.capacity === null
                        ? `${e.entrantCount} entered · unlimited`
                        : `${e.entrantCount} of ${e.capacity} ${e.registrationMode === 'team' ? 'teams' : 'places'}`}
                    </dd>
                    {e.registrationMode === 'team' && e.teamSize !== null && (
                      <dd>{e.teamSize} per team</dd>
                    )}
                    <dd>
                      {Number(e.entryFee) === 0
                        ? 'Free entry'
                        : `${formatMoney(e.entryFee, currency)}${e.registrationMode === 'team' ? ' per team' : ''}`}
                    </dd>
                    {e.tournamentFormat && (
                      <dd className="flex items-center gap-1.5">
                        <Trophy size={14} /> {TOURNAMENT_FORMAT_LABELS[e.tournamentFormat]}
                      </dd>
                    )}
                    {/* M15 #4 — what this event holds, and whether it is holding
                        it YET. A draft keeps its selection and reserves nothing
                        (statusBlocks in lib/events/resource-blocks.ts), so the
                        list says so rather than implying stations are locked. */}
                    {e.resourceScope !== 'none' && (
                      <dd className="flex items-center gap-1.5">
                        <Gamepad2 size={14} />
                        {e.resourceScope === 'branch'
                          ? 'Whole venue'
                          : `${e.resourceIds.length} station${e.resourceIds.length === 1 ? '' : 's'}`}
                        <span className="text-xs">
                          {BLOCKING_STATUSES.has(e.status) ? '· held' : '· not held yet'}
                        </span>
                      </dd>
                    )}
                  </dl>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Link
                    href={`/settings/events/${e.id}`}
                    aria-label="View entrants"
                    className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    <ListChecks size={16} />
                  </Link>
                  <button
                    type="button"
                    aria-label="Edit event"
                    className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={() => setModal({ mode: 'edit', row: e })}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete event"
                    className="rounded-lg p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                    disabled={pending}
                    onClick={() =>
                      confirm({
                        title: `Delete event "${e.title}"?`,
                        description: 'This cannot be undone.',
                        confirmText: 'Delete',
                        onConfirm: async () => {
                          const r = await deleteEvent(e.id)
                          if (r.error) toast.error(r.error)
                          else {
                            toast.success('Event deleted.')
                            router.refresh()
                          }
                        },
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* Only the moves the lifecycle actually permits are offered, so an
                  invalid transition is unreachable from the UI as well as
                  rejected by the server. */}
              {!isTerminal(e.status) && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Move to</span>
                  {EVENT_TRANSITIONS[e.status].map((next) => (
                    <button
                      key={next}
                      type="button"
                      disabled={pending}
                      className={`${btn} border border-border px-2.5 py-1 text-xs hover:bg-muted`}
                      onClick={() =>
                        run(
                          () => setEventStatus(e.id, next),
                          () => toast.success(`Moved to ${EVENT_STATUS_LABELS[next]}.`),
                        )
                      }
                    >
                      {EVENT_STATUS_LABELS[next]}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {modal && (
        <EventModal
          modal={modal}
          branches={branches}
          resources={resources}
          pending={pending}
          onClose={() => setModal(null)}
          onSave={(values) =>
            run(() => upsertEvent(values), () => {
              toast.success(modal.mode === 'add' ? 'Event created.' : 'Event updated.')
              setModal(null)
            })
          }
        />
      )}
    </div>
  )
}

function EventModal({
  modal,
  branches,
  resources,
  pending,
  onClose,
  onSave,
}: {
  modal: Modal
  branches: Branch[]
  resources: ResourceOption[]
  pending: boolean
  onClose: () => void
  onSave: (v: EventFormValues) => void
}) {
  const row = modal.mode === 'edit' ? modal.row : null
  const [branchId, setBranchId] = useState(row?.branchId ?? branches[0]?.id ?? '')
  const [title, setTitle] = useState(row?.title ?? '')
  const [type, setType] = useState<EventType>(row?.type ?? 'tournament')
  const [description, setDescription] = useState(row?.description ?? '')
  const [bannerUrl, setBannerUrl] = useState(row?.bannerUrl ?? '')
  const [startsAt, setStartsAt] = useState(row ? toLocalInput(row.startsAt) : '')
  const [endsAt, setEndsAt] = useState(row ? toLocalInput(row.endsAt) : '')
  const [capacity, setCapacity] = useState(row?.capacity != null ? String(row.capacity) : '')
  const [entryFee, setEntryFee] = useState(row?.entryFee ?? '0')
  const [tournamentFormat, setTournamentFormat] = useState<TournamentFormat | ''>(
    row?.tournamentFormat ?? 'single_elim',
  )
  const [registrationMode, setRegistrationMode] = useState<EventRegistrationMode>(
    row?.registrationMode ?? 'solo',
  )
  const [teamSize, setTeamSize] = useState(row?.teamSize != null ? String(row.teamSize) : '5')
  // M15 #4 — what this event reserves.
  const [resourceScope, setResourceScope] = useState<EventResourceScope>(row?.resourceScope ?? 'none')
  const [resourceIds, setResourceIds] = useState<string[]>(row?.resourceIds ?? [])

  // Only this venue's stations are selectable. Changing the venue clears the
  // selection rather than carrying ids that now belong to a different branch —
  // the server would refuse those anyway (setEventResources validates every id
  // against the event's branch), so this keeps the form honest about it.
  const branchResources = useMemo(
    () => resources.filter((r) => r.branchId === branchId),
    [resources, branchId],
  )
  const branchResourceIds = useMemo(
    () => new Set(branchResources.map((r) => r.id)),
    [branchResources],
  )
  const selectedInBranch = useMemo(
    () => resourceIds.filter((id) => branchResourceIds.has(id)),
    [resourceIds, branchResourceIds],
  )

  const needsFormat = requiresTournamentFormat(type)
  const isTeam = registrationMode === 'team'

  /**
   * The SAME validateEventFields() the server action runs, so the manager sees
   * the problem before a round trip and the two can never disagree. Only the
   * two rules that are purely about the form (a venue chosen, a title typed)
   * are checked here; everything else is the shared rule set.
   */
  const clientError = useMemo(() => {
    if (!branchId) return 'Select a venue.'
    if (!title.trim()) return 'Title is required.'
    if (!startsAt || !endsAt) return 'Start and end times are required.'
    if (resourceScope === 'specific' && selectedInBranch.length === 0) {
      return 'Choose at least one station, or set the event to reserve nothing.'
    }
    return validateEventFields({
      type,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      capacity: capacity === '' ? null : Number(capacity),
      entryFee: Number(entryFee),
      tournamentFormat: needsFormat ? (tournamentFormat as TournamentFormat) : null,
      registrationMode,
      teamSize: isTeam && teamSize !== '' ? Number(teamSize) : null,
    })
  }, [
    branchId,
    title,
    startsAt,
    endsAt,
    capacity,
    entryFee,
    type,
    needsFormat,
    tournamentFormat,
    registrationMode,
    isTeam,
    teamSize,
    resourceScope,
    selectedInBranch,
  ])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-8 w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{modal.mode === 'add' ? 'New Event' : 'Edit Event'}</h2>
          <button type="button" aria-label="Close" className="rounded-lg p-1.5 hover:bg-muted" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className={label} htmlFor="ev-title">Title</label>
            <input id="ev-title" className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="ev-type">Type</label>
              <select
                id="ev-type"
                className={input}
                value={type}
                onChange={(e) => {
                  const next = e.target.value as EventType
                  setType(next)
                  // Keep the format consistent with the type the moment it
                  // changes, so the payload can never carry a bracket format on
                  // a birthday party (the events_tournament_format CHECK).
                  setTournamentFormat(requiresTournamentFormat(next) ? 'single_elim' : '')
                }}
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>{EVENT_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="ev-branch">Venue</label>
              <select id="ev-branch" className={input} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {needsFormat && (
            <div>
              <label className={label} htmlFor="ev-format">Bracket Format</label>
              <select
                id="ev-format"
                className={input}
                value={tournamentFormat}
                onChange={(e) => setTournamentFormat(e.target.value as TournamentFormat)}
              >
                {TOURNAMENT_FORMATS.map((f) => (
                  <option key={f} value={f}>{TOURNAMENT_FORMAT_LABELS[f]}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="ev-start">Starts</label>
              <input id="ev-start" type="datetime-local" className={input} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="ev-end">Ends</label>
              <input id="ev-end" type="datetime-local" className={input} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>

          {/* Solo vs team changes what capacity and the fee MEAN, so it sits
              directly above both rather than in a separate section. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="ev-mode">Entry</label>
              <select
                id="ev-mode"
                className={input}
                value={registrationMode}
                onChange={(e) => setRegistrationMode(e.target.value as EventRegistrationMode)}
              >
                {EVENT_REGISTRATION_MODES.map((m) => (
                  <option key={m} value={m}>{EVENT_REGISTRATION_MODE_LABELS[m]}</option>
                ))}
              </select>
            </div>
            {isTeam && (
              <div>
                <label className={label} htmlFor="ev-team-size">Players per team</label>
                <input
                  id="ev-team-size"
                  type="number"
                  min={MIN_TEAM_SIZE}
                  max={MAX_TEAM_SIZE}
                  step={1}
                  className={input}
                  value={teamSize}
                  onChange={(e) => setTeamSize(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="ev-cap">
                Capacity {isTeam ? '(teams)' : '(places)'}
              </label>
              <input id="ev-cap" type="number" min={1} step={1} placeholder="Unlimited" className={input} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="ev-fee">
                Entry Fee {isTeam ? '(per team)' : ''}
              </label>
              <input id="ev-fee" type="number" min={0} step="0.01" className={input} value={entryFee} onChange={(e) => setEntryFee(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={label} htmlFor="ev-desc">Description</label>
            <textarea id="ev-desc" rows={3} className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <ImageUploadField label="Banner" value={bannerUrl} onChange={setBannerUrl} upload={uploadEventBanner} />

          {/* ── M15 #4: what the event reserves ─────────────────────────────
              Presentation only. The server recomputes the blocks inside the
              same transaction as the save and refuses the whole edit if a
              station is already taken, so nothing here is load-bearing — it
              only spares the manager a round trip. Stations are shown by NAME;
              their ids never reach the screen. */}
          <div>
            <span className={label}>Reserves</span>
            <div className="mt-1 space-y-1.5">
              {(
                [
                  ['none', 'Nothing — the event does not hold any stations'],
                  ['branch', 'The whole venue — every bookable station for the event window'],
                  ['specific', 'Selected stations only'],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="ev-scope"
                    className="mt-0.5"
                    checked={resourceScope === value}
                    onChange={() => setResourceScope(value)}
                  />
                  <span>{text}</span>
                </label>
              ))}
            </div>

            {resourceScope === 'specific' && (
              <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-border p-2">
                {branchResources.length === 0 ? (
                  <p className="px-1 py-2 text-sm text-muted-foreground">
                    This venue has no bookable stations yet.
                  </p>
                ) : (
                  branchResources.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 px-1 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={resourceIds.includes(r.id)}
                        onChange={(e) =>
                          setResourceIds((prev) =>
                            e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id),
                          )
                        }
                      />
                      <span>{r.name}</span>
                      {r.status !== 'available' && (
                        <span className="text-xs text-muted-foreground">({r.status})</span>
                      )}
                    </label>
                  ))
                )}
              </div>
            )}

            {resourceScope !== 'none' && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Stations are held once the event is published, and released when it is completed or
                cancelled. A draft holds nothing.
              </p>
            )}
          </div>

          {clientError && <p className="text-sm text-destructive">{clientError}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={`${btn} border border-border hover:bg-muted`} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            disabled={pending || clientError !== null}
            onClick={() =>
              onSave({
                id: row?.id,
                branchId,
                title,
                type,
                description,
                bannerUrl,
                startsAt: new Date(startsAt).toISOString(),
                endsAt: new Date(endsAt).toISOString(),
                capacity: capacity === '' ? '' : Number(capacity),
                entryFee: Number(entryFee),
                tournamentFormat: needsFormat ? tournamentFormat : '',
                registrationMode,
                // '' rather than 0 for a solo event — the action maps the empty
                // string to null, which is what events_team_size demands.
                teamSize: isTeam ? Number(teamSize) : '',
                resourceScope,
                // Only meaningful for 'specific'; the action ignores it otherwise
                // and clears the selection, which is what releases the blocks.
                resourceIds: resourceScope === 'specific' ? selectedInBranch : [],
              })
            }
          >
            {pending ? <Loader2 size={16} className="animate-spin" /> : modal.mode === 'add' ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
