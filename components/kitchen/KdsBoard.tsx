'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Bell, Check, Clock, Flame, Loader2, MapPin, PackageX, Pause, Printer, RotateCcw, Smartphone, Undo2 } from 'lucide-react'
import { bumpKot, bumpKotItem, fireCourse, recallKot, recallKotItem } from '@/lib/actions/kds'
import { updateKotStatus } from '@/lib/actions/kots'
import type { KdsBoard as KdsBoardData, KdsTicket } from '@/lib/kots/kds-data'
import { usePolling } from './usePolling'
import { EightySixPanel, type EightySixItem } from './EightySixPanel'
import { OrderTypeBadge } from '@/components/orders/OrderTypeBadge'

/** Adaptive polling: fast while the screen is visible, none while the tab is
 *  hidden (a screen that's asleep shouldn't hit the database), and an
 *  immediate refresh the moment it becomes visible again. */
const POLL_MS = 4000

type Level = 'ok' | 'warn' | 'late'

function levelFor(mins: number, warn: number, late: number): Level {
  return mins >= late ? 'late' : mins >= warn ? 'warn' : 'ok'
}

const LEVEL_STYLE: Record<Level, { card: string; accent: string; timer: string }> = {
  ok: { card: 'border-border', accent: 'bg-emerald-500', timer: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  warn: { card: 'border-amber-400/70', accent: 'bg-amber-500', timer: 'bg-amber-500 text-black' },
  late: { card: 'border-red-500/70 shadow-red-500/10', accent: 'bg-red-600', timer: 'bg-red-600 text-white' },
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function KdsBoard({
  board,
  menuItems,
  canBump,
  canFire,
  scope,
}: {
  board: KdsBoardData
  menuItems: EightySixItem[]
  canBump: boolean
  /** Waiters/cashiers can fire a held course even though they can't bump. */
  canFire: boolean
  /** The station screen being shown: undefined = every station, `{ id: null }` = unrouted. */
  scope?: { id: string | null }
}) {
  const router = useRouter()
  const { settings, tickets, heldOnly, allDay } = board
  // Offset between the server clock and this device's clock, so a wall display
  // with a wrong clock still shows true waiting times.
  const offset = useMemo(() => new Date(board.serverNow).getTime() - Date.now(), [board.serverNow])
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [show86, setShow86] = useState(false)
  const [, startTransition] = useTransition()

  usePolling(POLL_MS)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const run = useCallback(
    (key: string, fn: () => Promise<{ error?: string }>) => {
      setError(null)
      setBusy(key)
      startTransition(async () => {
        const r = await fn()
        if (r.error) setError(r.error)
        router.refresh()
        setBusy(null)
      })
    },
    [router],
  )

  const active = tickets
    .filter((t) => t.status !== 'ready')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const ready = tickets.filter((t) => t.status === 'ready')

  return (
    <div className="mt-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 font-medium shadow-sm">
            <Flame size={14} className="text-primary" />
            <span className="tabular-nums">{active.length}</span> cooking
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 font-medium shadow-sm">
            <Bell size={14} className="text-emerald-600" />
            <span className="tabular-nums">{ready.length}</span> ready
          </span>
          {heldOnly.length > 0 && (
            <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 font-medium text-amber-700 dark:text-amber-400">
              <Pause size={14} />
              <span className="tabular-nums">{heldOnly.length}</span> on hold
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShow86(true)}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold shadow-sm transition hover:border-primary/40 hover:bg-muted"
        >
          <PackageX size={16} className="text-primary" /> 86 items
        </button>
      </div>

      {settings.stationsEnabled && <StationTabs stations={board.stations} scope={scope} />}

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {!canBump && (
        <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          View only — bumping is for kitchen staff, managers and owners.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_17rem]">
        <div className="space-y-7">
          {active.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/20 p-14 text-center text-base text-muted-foreground">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <Check size={24} />
              </span>
              All clear. New tickets appear here the moment they&apos;re fired.
            </div>
          ) : (
            <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 2xl:grid-cols-3">
              {active.map((t) => (
                <TicketCard
                  key={t.kotId}
                  ticket={t}
                  elapsedMs={now + offset - new Date(t.startedAt).getTime()}
                  warn={settings.warnMinutes}
                  late={settings.lateMinutes}
                  busy={busy}
                  canBump={canBump}
                  canFire={canFire}
                  scope={scope}
                  showStation={scope === undefined && settings.stationsEnabled}
                  run={run}
                />
              ))}
            </div>
          )}

          {heldOnly.length > 0 && (
            <section aria-label="On hold">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-amber-600">
                <Pause size={16} /> On hold — not sent to the cook yet
              </h2>
              <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {heldOnly.map((t) => (
                  <div key={t.kotId} className="rounded-2xl border border-dashed border-amber-500/60 bg-amber-500/5 p-4">
                    <p className="text-base font-semibold">
                      {t.kotNumber}
                      {t.tableName ? ` · ${t.tableName}` : ''}
                    </p>
                    <HeldGroups ticket={t} busy={busy} canFire={canFire} run={run} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {ready.length > 0 && (
            <section aria-label="Ready to run">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-emerald-600">
                <Bell size={16} /> Ready to run
              </h2>
              <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {ready.map((t) => (
                  <div key={t.kotId} className="rounded-2xl border border-emerald-500/50 bg-emerald-500/5 p-4 shadow-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-base font-semibold">
                        {t.kotNumber}
                        {t.tableName ? ` · ${t.tableName}` : ''}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t.items.reduce((n, i) => n + i.qty, 0)} items
                      </span>
                    </div>
                    <HeldGroups ticket={t} busy={busy} canFire={canFire} run={run} />
                    <div className="mt-3 flex gap-2">
                      {canBump && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => run(t.kotId, () => recallKot(t.kotId))}
                          className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted disabled:opacity-50"
                        >
                          {busy === t.kotId ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                          Recall
                        </button>
                      )}
                      {canBump && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => run(t.kotId, () => updateKotStatus(t.kotId, 'served'))}
                          className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          <Check size={16} /> Served
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside aria-label="All-day counts" className="h-fit overflow-hidden rounded-2xl border border-border bg-card shadow-sm lg:sticky lg:top-4">
          <div className="border-b border-border bg-muted/40 px-4 py-3">
            <h2 className="text-base font-semibold">All day</h2>
            <p className="text-xs text-muted-foreground">Still to cook, across all tickets</p>
          </div>
          {allDay.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted-foreground">Nothing outstanding.</p>
          ) : (
            <ul className="divide-y divide-border/70 px-4">
              {allDay.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-3 py-2.5 text-base">
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <span className="flex h-8 min-w-8 items-center justify-center rounded-lg bg-primary/10 px-2 text-lg font-bold tabular-nums text-primary">
                    {c.qty}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {show86 && <EightySixPanel items={menuItems} onClose={() => setShow86(false)} />}
    </div>
  )
}

function TicketCard({
  ticket,
  elapsedMs,
  warn,
  late,
  busy,
  canBump,
  canFire,
  scope,
  showStation,
  run,
}: {
  ticket: KdsTicket
  elapsedMs: number
  warn: number
  late: number
  busy: string | null
  canBump: boolean
  canFire: boolean
  scope?: { id: string | null }
  /** Tag each line with its station (the all-stations view only). */
  showStation: boolean
  run: (key: string, fn: () => Promise<{ error?: string }>) => void
}) {
  const level = levelFor(Math.floor(elapsedMs / 60000), warn, late)
  const style = LEVEL_STYLE[level]
  const left = ticket.items.filter((i) => !i.bumped).length

  return (
    <div className={`relative flex flex-col rounded-2xl border bg-card p-4 shadow-sm ${style.card}`}>
      <span aria-hidden className={`absolute inset-x-8 top-0 h-[3px] rounded-b-full ${style.accent}`} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-base font-bold tracking-tight">{ticket.kotNumber}</span>
          {ticket.channel === 'online' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
              <Smartphone size={10} /> Online
            </span>
          )}
        </div>
        <span
          aria-label={`Waiting ${clock(elapsedMs)}`}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-bold tabular-nums ${style.timer}`}
        >
          <Clock size={13} aria-hidden />
          {clock(elapsedMs)}
        </span>
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>order {ticket.orderNumber}</span>
        {ticket.tableName && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
            <MapPin size={11} /> {ticket.tableName}
          </span>
        )}
        <OrderTypeBadge orderType={ticket.orderType} contactName={ticket.contactName} pickupAt={ticket.pickupAt} />
        <Link
          href={`/kitchen/${ticket.kotId}/print`}
          aria-label={`Print ticket ${ticket.kotNumber}`}
          className="ml-auto rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Printer size={16} />
        </Link>
      </p>

      <ul className="mt-3 flex-1 space-y-1.5">
        {ticket.items.map((item, idx) => {
          const key = `${ticket.kotId}:${item.itemId}`
          const content = (
            <>
              <span className="flex items-center justify-between gap-3">
                <span className={`min-w-0 text-[15px] font-semibold leading-tight ${item.bumped ? 'line-through' : ''}`}>
                  <span className="mr-1.5 text-muted-foreground">{item.qty}×</span>
                  {item.name}
                  {showStation && item.stationName && (
                    <span className="ml-2 rounded-full bg-background px-1.5 py-px align-middle text-[9px] font-bold uppercase tracking-wide text-muted-foreground ring-1 ring-border">
                      {item.stationName}
                    </span>
                  )}
                </span>
                {canBump && (
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      item.bumped
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : 'border border-border bg-background text-muted-foreground'
                    }`}
                  >
                    {busy === key ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : item.bumped ? (
                      <Undo2 size={14} aria-hidden />
                    ) : (
                      <Check size={14} aria-hidden />
                    )}
                  </span>
                )}
              </span>
              {item.modifiers.length > 0 && (
                <span className="block text-sm font-medium text-primary">— {item.modifiers.join(', ')}</span>
              )}
              {item.notes && <span className="block text-sm font-medium text-amber-600">— {item.notes}</span>}
            </>
          )
          const cls = `block w-full rounded-lg px-3 py-2 text-left ${
            item.bumped ? 'bg-emerald-500/10 text-muted-foreground' : 'bg-muted/50 hover:bg-muted'
          }`
          // Course sub-headers only when this table actually uses courses.
          const showCourse =
            item.courseName !== null && (idx === 0 || ticket.items[idx - 1].courseNo !== item.courseNo)
          return (
            <li key={item.itemId}>
              {showCourse && (
                <p className="mb-1.5 mt-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  <Flame size={12} /> {item.courseName}
                  <span aria-hidden className="h-px flex-1 bg-border" />
                </p>
              )}
              {canBump ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  aria-label={`${item.bumped ? 'Recall' : 'Bump'} ${item.qty} ${item.name}`}
                  onClick={() =>
                    run(key, () => (item.bumped ? recallKotItem(ticket.kotId, item.itemId) : bumpKotItem(ticket.kotId, item.itemId)))
                  }
                  className={`${cls} min-h-12 transition active:scale-[0.99] disabled:opacity-60`}
                >
                  {content}
                </button>
              ) : (
                <div className={cls}>{content}</div>
              )}
            </li>
          )
        })}
      </ul>

      <HeldGroups ticket={ticket} busy={busy} canFire={canFire} run={run} />

      {canBump && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => run(ticket.kotId, () => bumpKot(ticket.kotId, scope))}
          className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition hover:shadow-md hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
        >
          {busy === ticket.kotId ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          Bump ticket{left < ticket.items.length ? ` (${left} left)` : ''}
        </button>
      )}
    </div>
  )
}

/** Held courses on a ticket, each with its own Fire button — the clear
 *  "held vs active" separation: amber dashed = waiting, solid card = cooking. */
function HeldGroups({
  ticket,
  busy,
  canFire,
  run,
}: {
  ticket: KdsTicket
  busy: string | null
  canFire: boolean
  run: (key: string, fn: () => Promise<{ error?: string }>) => void
}) {
  if (ticket.held.length === 0) return null
  return (
    <div className="mt-3 space-y-2">
      {ticket.held.map((g) => {
        const key = `${ticket.kotId}:fire:${g.course}`
        return (
          <div key={g.course} className="rounded-xl border border-dashed border-amber-500/70 bg-amber-500/5 p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-amber-600">
              <Pause size={12} /> Held · {g.name}
            </p>
            <ul className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
              {g.items.map((i) => (
                <li key={i.itemId}>
                  {i.qty}× {i.name}
                  {i.modifiers.length > 0 ? ` — ${i.modifiers.join(', ')}` : ''}
                </li>
              ))}
            </ul>
            {canFire && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run(key, () => fireCourse(ticket.orderId, g.course))}
                className="mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-amber-500 text-sm font-semibold text-black shadow-sm transition hover:bg-amber-400 active:scale-[0.99] disabled:opacity-50"
              >
                {busy === key ? <Loader2 size={16} className="animate-spin" /> : <Flame size={16} />}
                Fire {g.name}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** One tab per station (a wall screen per station bookmarks its tab), plus
 *  lines with no station and the expo/pass view. */
function StationTabs({ stations, scope }: { stations: { id: string; name: string }[]; scope?: { id: string | null } }) {
  const tab = (active: boolean) =>
    `inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold transition ${
      active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background hover:text-foreground'
    }`
  return (
    <nav aria-label="Stations" className="flex w-fit max-w-full flex-wrap gap-1 rounded-full border border-border bg-muted/50 p-1">
      <Link href="/kitchen" className={tab(scope === undefined)}>
        All stations
      </Link>
      {stations.map((s) => (
        <Link key={s.id} href={`/kitchen?station=${s.id}`} className={tab(scope?.id === s.id)}>
          {s.name}
        </Link>
      ))}
      <Link href="/kitchen?station=none" className={tab(scope !== undefined && scope.id === null)}>
        Unassigned
      </Link>
      <Link href="/kitchen/expo" className={tab(false)}>
        Expo / pass →
      </Link>
    </nav>
  )
}
