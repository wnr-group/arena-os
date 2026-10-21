'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Bell, Check, Flame, Loader2, MapPin, PackageX, Pause, Printer, RotateCcw, Smartphone, Undo2 } from 'lucide-react'
import { bumpKot, bumpKotItem, fireCourse, recallKot, recallKotItem } from '@/lib/actions/kds'
import { updateKotStatus } from '@/lib/actions/kots'
import type { KdsBoard as KdsBoardData, KdsTicket } from '@/lib/kots/kds-data'
import { EightySixPanel, type EightySixItem } from './EightySixPanel'

/** Adaptive polling: fast while the screen is visible, none while the tab is
 *  hidden (a screen that's asleep shouldn't hit the database), and an
 *  immediate refresh the moment it becomes visible again. */
const POLL_MS = 4000

type Level = 'ok' | 'warn' | 'late'

function levelFor(mins: number, warn: number, late: number): Level {
  return mins >= late ? 'late' : mins >= warn ? 'warn' : 'ok'
}

const LEVEL_STYLE: Record<Level, { card: string; timer: string }> = {
  ok: { card: 'border-border', timer: 'bg-muted text-foreground' },
  warn: { card: 'border-amber-500', timer: 'bg-amber-500 text-black' },
  late: { card: 'border-red-600 ring-2 ring-red-600/40', timer: 'bg-red-600 text-white' },
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
}: {
  board: KdsBoardData
  menuItems: EightySixItem[]
  canBump: boolean
  /** Waiters/cashiers can fire a held course even though they can't bump. */
  canFire: boolean
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

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), POLL_MS)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        router.refresh()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router])

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
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {active.length} cooking · {ready.length} ready{heldOnly.length > 0 ? ` · ${heldOnly.length} on hold` : ''} · live
        </p>
        <button
          type="button"
          onClick={() => setShow86(true)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-4 text-sm font-medium transition hover:bg-muted"
        >
          <PackageX size={16} /> 86 items
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {!canBump && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          View only — bumping is for kitchen staff, managers and owners.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-6">
          {active.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-12 text-center text-base text-muted-foreground">
              All clear. New tickets appear here the moment they&apos;re fired.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
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
                  run={run}
                />
              ))}
            </div>
          )}

          {heldOnly.length > 0 && (
            <section aria-label="On hold">
              <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-amber-600">
                <Pause size={16} /> On hold — not sent to the cook yet
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {heldOnly.map((t) => (
                  <div key={t.kotId} className="rounded-xl border border-dashed border-amber-500/60 bg-amber-500/5 p-3">
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
              <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-emerald-600">
                <Bell size={16} /> Ready to run
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {ready.map((t) => (
                  <div key={t.kotId} className="rounded-xl border border-emerald-500/50 bg-emerald-500/5 p-3">
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

        <aside aria-label="All-day counts" className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-4">
          <h2 className="text-base font-semibold">All day</h2>
          <p className="text-xs text-muted-foreground">Still to cook, across all tickets</p>
          {allDay.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Nothing outstanding.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {allDay.map((c) => (
                <li key={c.key} className="flex items-baseline justify-between gap-3 text-base">
                  <span className="min-w-0 truncate">{c.name}</span>
                  <span className="text-xl font-bold tabular-nums">{c.qty}</span>
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
  run,
}: {
  ticket: KdsTicket
  elapsedMs: number
  warn: number
  late: number
  busy: string | null
  canBump: boolean
  canFire: boolean
  run: (key: string, fn: () => Promise<{ error?: string }>) => void
}) {
  const level = levelFor(Math.floor(elapsedMs / 60000), warn, late)
  const style = LEVEL_STYLE[level]
  const left = ticket.items.filter((i) => !i.bumped).length

  return (
    <div className={`flex flex-col rounded-xl border-2 bg-card p-3 shadow-sm ${style.card}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-lg font-bold">{ticket.kotNumber}</span>
          {ticket.channel === 'online' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
              <Smartphone size={10} /> Online
            </span>
          )}
        </div>
        <span
          aria-label={`Waiting ${clock(elapsedMs)}`}
          className={`rounded-md px-2.5 py-1 text-lg font-bold tabular-nums ${style.timer}`}
        >
          {clock(elapsedMs)}
        </span>
      </div>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        order {ticket.orderNumber}
        {ticket.tableName && (
          <>
            {' · '}
            <MapPin size={12} /> {ticket.tableName}
          </>
        )}
        <Link
          href={`/kitchen/${ticket.kotId}/print`}
          aria-label={`Print ticket ${ticket.kotNumber}`}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <Printer size={15} />
        </Link>
      </p>

      <ul className="mt-2 flex-1 space-y-1.5">
        {ticket.items.map((item, idx) => {
          const key = `${ticket.kotId}:${item.itemId}`
          const content = (
            <>
              <span className="flex items-start justify-between gap-2">
                <span className={`text-lg font-semibold leading-tight ${item.bumped ? 'line-through' : ''}`}>
                  {item.qty}× {item.name}
                </span>
                {canBump &&
                  (busy === key ? (
                    <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" />
                  ) : item.bumped ? (
                    <Undo2 size={18} className="mt-0.5 shrink-0" aria-hidden />
                  ) : (
                    <Check size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                  ))}
              </span>
              {item.modifiers.length > 0 && (
                <span className="block text-sm font-medium text-primary">— {item.modifiers.join(', ')}</span>
              )}
              {item.notes && <span className="block text-sm font-medium text-amber-600">— {item.notes}</span>}
            </>
          )
          const cls = `block w-full rounded-lg px-3 py-2 text-left ${
            item.bumped ? 'bg-emerald-500/10 text-muted-foreground' : 'bg-muted/50'
          }`
          // Course sub-headers only when this table actually uses courses.
          const showCourse =
            item.courseName !== null && (idx === 0 || ticket.items[idx - 1].courseNo !== item.courseNo)
          return (
            <li key={item.itemId}>
              {showCourse && (
                <p className="mb-1 mt-1 flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  <Flame size={12} /> {item.courseName}
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
                  className={`${cls} min-h-14 transition active:scale-[0.99] disabled:opacity-60`}
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
          onClick={() => run(ticket.kotId, () => bumpKot(ticket.kotId))}
          className="mt-3 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-sm transition hover:shadow-md disabled:opacity-50"
        >
          {busy === ticket.kotId ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
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
          <div key={g.course} className="rounded-lg border border-dashed border-amber-500/70 bg-amber-500/5 p-2">
            <p className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-amber-600">
              <Pause size={12} /> Held · {g.name}
            </p>
            <ul className="mt-1 text-sm text-muted-foreground">
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
                className="mt-2 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-amber-500 text-sm font-semibold text-black transition hover:bg-amber-400 disabled:opacity-50"
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
