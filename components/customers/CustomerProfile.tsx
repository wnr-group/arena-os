import Link from 'next/link'
import { ArrowLeft, CalendarDays, Coins, Sparkles, Wallet } from 'lucide-react'
import {
  MembershipPanel,
  type MembershipRow,
  type PlanOption,
} from './MembershipPanel'
import { WalletTopUp } from './WalletTopUp'
import type { CustomerProfileData } from '@/lib/customers/profile'
import { formatMoney, prettyDate, timeInZone } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { CustomerNotes } from './CustomerNotes'
import { CustomerTags } from './CustomerTags'

const STATUS_STYLE: Record<string, string> = {
  confirmed: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  checked_in: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  completed: 'bg-zinc-500/10 text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  no_show: 'bg-amber-500/10 text-amber-600 dark:text-amber-500',
}

/** "AI" from "Asha Iyer"; falls back to the last two digits of the phone. */
function initials(name: string | null, phone: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return phone.slice(-2)
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

function duration(minutes: number): string {
  if (!minutes) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

export function CustomerProfile({
  data,
  timeZone,
  currency,
  canManage,
  canSellMemberships,
  memberships,
  membershipPlans,
}: {
  data: CustomerProfileData
  timeZone: string
  currency: string
  /** May this member edit notes and tags? (Read-only otherwise.) */
  canManage: boolean
  /** Cashier and up — may sell or cancel a membership (AROS-60). */
  canSellMemberships: boolean
  /** Eligibility is precomputed server-side; see the page. */
  memberships: MembershipRow[]
  membershipPlans: PlanOption[]
}) {
  const { customer: c, stats } = data
  const day = (d: Date) => prettyDate(todayInZone(timeZone, d), timeZone)
  // Notes need the time of day too — several can land on one date. Formatting
  // here (not in the client component) keeps the tenant timezone server-side,
  // the same way the directory passes a ready-made `createdLabel`.
  const stamp = (d: Date) => `${day(d)}, ${timeInZone(d, timeZone)}`

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <Link
        href="/customers"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={15} /> All customers
      </Link>

      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-start gap-4">
        <div
          aria-hidden
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground"
        >
          {initials(c.name, c.phone)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">
            {c.name || <span className="text-muted-foreground">No name</span>}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {c.phone}
            {' · '}
            {c.email || 'No email'}
          </p>
          <CustomerTags customerId={c.id} tags={c.tags} canManage={canManage} />
        </div>
        {c.membershipStatus && (
          <span className="rounded-full border px-3 py-1 text-xs font-medium capitalize">
            {c.membershipStatus}
          </span>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-4">
        <Field label="Phone" value={c.phone} />
        <Field label="Email" value={c.email} empty="No email" />
        <Field
          label="Date of birth"
          value={c.dob ? prettyDate(c.dob, timeZone) : null}
          empty="Not recorded"
        />
        <Field label="Customer since" value={day(c.createdAt)} />
      </dl>

      {/* ── summary cards ──────────────────────────────────────────────── */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={CalendarDays} label="Total bookings" value={String(stats.totalBookings)} />
        <Stat icon={Sparkles} label="Total visits" value={String(stats.totalVisits)} />
        <Stat
          icon={Wallet}
          label="Wallet balance"
          value={formatMoney(stats.walletBalance, currency)}
        />
        <Stat icon={Coins} label="Loyalty points" value={String(stats.loyaltyPoints)} />
      </div>

      {/* ── booking history ────────────────────────────────────────────── */}
      <Section title="Booking history">
        {data.bookings.length === 0 ? (
          <Empty>
            No bookings yet. Bookings taken with this customer&apos;s phone number will appear here.
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Booking</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Resource</th>
                  <th className="px-4 py-2.5 font-medium">Duration</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.bookings.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-medium">{b.bookingNumber}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {b.startsAt ? (
                        <>
                          {day(b.startsAt)}
                          <span className="block text-xs text-muted-foreground">
                            {timeInZone(b.startsAt, timeZone)}
                            {b.endsAt && `–${timeInZone(b.endsAt, timeZone)}`}
                          </span>
                        </>
                      ) : (
                        day(b.createdAt)
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {b.resources.length ? (
                        b.resources.join(', ')
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{duration(b.minutes)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                          STATUS_STYLE[b.status] ?? 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {b.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {formatMoney(b.total, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── notes ──────────────────────────────────────────────────────── */}
      <Section title="Notes">
        <CustomerNotes
          customerId={c.id}
          canManage={canManage}
          notes={data.notes.map((n) => ({
            id: n.id,
            body: n.body,
            authorName: n.createdByName,
            createdLabel: stamp(n.createdAt),
            // The trigger only moves updated_at on a real UPDATE, so anything
            // later than created_at means the note was genuinely edited.
            editedLabel:
              n.updatedAt.getTime() > n.createdAt.getTime() ? stamp(n.updatedAt) : null,
          }))}
        />
      </Section>

      {/* ── membership (AROS-60) ────────────────────────────────────────── */}
      <MembershipPanel
        customerId={c.id}
        memberships={memberships}
        plans={membershipPlans}
        currency={currency}
        canSell={canSellMemberships}
      />

      {/* ── wallet + loyalty ───────────────────────────────────────────── */}
      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="Wallet">
          {/* stats.walletBalance is walletBalance() over the ledger — the sum of
              wallet_transactions.amount. There is no balance column to read. */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <LedgerTotal
              label="Current balance"
              value={formatMoney(stats.walletBalance, currency)}
            />
            <WalletTopUp
              customerId={c.id}
              currency={currency}
              canSell={canSellMemberships}
            />
          </div>
          {data.wallet.length === 0 ? (
            <Empty>No wallet activity yet.</Empty>
          ) : (
            <ul className="mt-3 divide-y rounded-lg border">
              {data.wallet.map((w) => {
                const amount = Number(w.amount)
                return (
                  <li key={w.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm">{w.reason || 'Adjustment'}</p>
                      <p className="text-xs text-muted-foreground">
                        {day(w.createdAt)}
                        {w.sourceType && ` · ${w.sourceType}`}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 text-sm font-medium ${
                        amount < 0 ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {amount > 0 ? '+' : ''}
                      {formatMoney(amount, currency)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section title="Loyalty">
          <LedgerTotal label="Current points" value={String(stats.loyaltyPoints)} />
          {data.loyalty.length === 0 ? (
            <Empty>No loyalty activity yet.</Empty>
          ) : (
            <ul className="mt-3 divide-y rounded-lg border">
              {data.loyalty.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm">{l.reason || 'Adjustment'}</p>
                    <p className="text-xs text-muted-foreground">
                      {day(l.createdAt)}
                      {l.sourceType && ` · ${l.sourceType}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-sm font-medium ${
                      l.points < 0 ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {l.points > 0 ? '+' : ''}
                    {l.points}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

/* ── small presentational pieces, kept local like BookingsView's Row/ActBtn ── */

function Field({
  label,
  value,
  empty = '—',
}: {
  label: string
  value: string | null
  empty?: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate">
        {value || <span className="text-muted-foreground">{empty}</span>}
      </dd>
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarDays
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg border p-4">
      <Icon size={16} className="text-primary" />
      <p className="mt-2 text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-semibold">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function LedgerTotal({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
