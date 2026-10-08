import type { CSSProperties } from 'react'
import { Banknote, Check, CheckCircle2, Clock, CreditCard, QrCode, Smartphone, Wallet, type LucideIcon } from 'lucide-react'

/** Small "Sample data" caption so illustrative numbers are never mistaken for real ones. */
function Sample() {
  return <span className="text-[10px] font-medium uppercase tracking-wide text-subtle-foreground">Sample data</span>
}

/** The tenant's public booking site, on a phone. */
export function SiteMockup() {
  return (
    <div className="relative mx-auto w-[16.5rem]">
      <div className="overflow-hidden rounded-[2.4rem] border-[7px] border-foreground bg-background shadow-2xl">
        <div className="mx-auto mt-1.5 h-4 w-20 rounded-full bg-foreground" />
        <div className="flex items-center justify-between px-4 pb-2 pt-2">
          <span className="text-xs font-extrabold tracking-tight">Play Arena</span>
          <span className="rounded-full bg-primary px-2.5 py-1 text-[10px] font-bold text-primary-foreground">
            Book Now
          </span>
        </div>
        <div className="mx-3 rounded-2xl bg-gradient-to-br from-primary to-[#c0396b] p-4 text-primary-foreground">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-white/70">Open · till 11 PM</p>
          <p className="mt-1 text-base font-extrabold leading-tight">Reserve your spot in seconds</p>
        </div>
        <div className="space-y-2 px-3 pt-3">
          {[
            ['PS5 Station', 'from ₹150/hr'],
            ['VR Pod', 'from ₹300/hr'],
          ].map(([n, p]) => (
            <div key={n} className="flex items-center gap-2.5 rounded-xl border border-border p-2">
              <span className="size-9 rounded-lg bg-gradient-to-br from-accent to-rose-bg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-bold">{n}</p>
                <p className="text-[10px] text-muted-foreground">{p}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="px-3 pb-4 pt-3">
          <p className="mb-1.5 text-[10px] font-semibold text-muted-foreground">Today · pick a time</p>
          <div className="grid grid-cols-3 gap-1.5">
            {['6:00 PM', '7:00 PM', '8:00 PM'].map((t, i) => (
              <span
                key={t}
                className={
                  i === 1
                    ? 'rounded-lg bg-primary py-1.5 text-center text-[10px] font-bold text-primary-foreground'
                    : 'rounded-lg border border-border py-1.5 text-center text-[10px] font-semibold'
                }
              >
                {t}
              </span>
            ))}
          </div>
          <div className="mt-3 rounded-xl bg-primary py-2 text-center text-[11px] font-bold text-primary-foreground">
            Pay ₹150 &amp; confirm
          </div>
        </div>
      </div>

      <div className="mk-float-a absolute -right-8 top-24 flex items-center gap-2 rounded-2xl border border-border bg-card p-2.5 pr-3.5 shadow-xl sm:-right-16">
        <span className="flex size-8 items-center justify-center rounded-lg bg-mint-bg text-mint">
          <QrCode size={16} />
        </span>
        <div>
          <p className="text-[11px] font-bold">Booking confirmed</p>
          <p className="text-[10px] text-muted-foreground">QR ticket ready</p>
        </div>
      </div>
    </div>
  )
}

const TENDERS: [LucideIcon, string, boolean][] = [
  [Smartphone, 'UPI', true],
  [CreditCard, 'Card', false],
  [Banknote, 'Cash', false],
  [Wallet, 'Wallet', false],
]

/** A walk-in bill: line items, happy-hour discount, GST split and payment tenders. */
export function PosMockup() {
  const lines: [string, string, boolean?][] = [
    ['Gaming · 2h 15m', '₹450.00'],
    ['Extra player × 1', '₹60.00'],
    ['Cold coffee × 2', '₹240.00'],
    ['Happy hour −10%', '−₹75.00', true],
  ]
  return (
    <div className="relative mx-auto w-full max-w-sm">
      <div className="rounded-2xl border border-border-strong bg-card p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-bold">Invoice #INV-0142</p>
            <p className="text-[11px] text-muted-foreground">PS5 · Station 2</p>
          </div>
          <Sample />
        </div>
        <div className="mt-4 space-y-2 border-t border-dashed border-border-strong pt-4 text-xs">
          {lines.map(([k, v, good]) => (
            <div key={k} className="flex justify-between">
              <span className={good ? 'font-medium text-mint' : 'text-muted-foreground'}>{k}</span>
              <span className={good ? 'font-semibold text-mint' : 'font-semibold'}>{v}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1.5 border-t border-dashed border-border-strong pt-3 text-[11px] text-muted-foreground">
          <div className="flex justify-between">
            <span>CGST 9%</span>
            <span>₹60.75</span>
          </div>
          <div className="flex justify-between">
            <span>SGST 9%</span>
            <span>₹60.75</span>
          </div>
        </div>
        <div className="mt-3 flex items-end justify-between border-t border-border-strong pt-3">
          <span className="text-xs font-semibold">Total</span>
          <span className="text-2xl font-extrabold tracking-tight">₹796.50</span>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-1.5 text-[10px] font-semibold">
          {TENDERS.map(([Icon, label, on]) => (
            <span
              key={label}
              className={
                on
                  ? 'flex flex-col items-center gap-1 rounded-lg border border-primary bg-primary/10 py-2 text-primary'
                  : 'flex flex-col items-center gap-1 rounded-lg border border-border py-2 text-muted-foreground'
              }
            >
              <Icon size={14} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="mk-pop absolute -right-3 -top-4 flex items-center gap-1.5 rounded-full bg-mint px-3 py-1.5 text-xs font-bold text-white shadow-lg sm:-right-6">
        <Check size={14} /> Paid
      </div>
      <div className="mk-float-b absolute -left-3 bottom-10 flex items-center gap-2 rounded-2xl border border-border bg-card p-2.5 pr-3.5 shadow-xl sm:-left-8">
        <span className="flex size-8 items-center justify-center rounded-lg bg-amber-bg text-amber">
          <Clock size={16} />
        </span>
        <div>
          <p className="text-[11px] font-bold">02:15:08</p>
          <p className="text-[10px] text-muted-foreground">Walk-in timer</p>
        </div>
      </div>
    </div>
  )
}

const KOTS = [
  {
    col: 'New',
    tone: 'bg-rose-bg text-rose border-rose-border',
    tickets: [
      ['KOT #118', 'Table 4', '2× Nachos, 1× Cola', '1m'],
      ['KOT #119', 'PS5 · 2', '1× Burger', 'now'],
    ],
  },
  {
    col: 'Preparing',
    tone: 'bg-amber-bg text-amber border-amber-border',
    tickets: [['KOT #117', 'Table 2', '3× Pizza', '8m']],
  },
  {
    col: 'Ready',
    tone: 'bg-mint-bg text-mint border-mint-border',
    tickets: [['KOT #116', 'VR · A', '2× Fries', '12m']],
  },
]

/** Kitchen queue with three status columns. */
export function KitchenMockup() {
  return (
    <div className="relative mx-auto w-full max-w-md rounded-2xl border border-border-strong bg-card p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-bold">Kitchen queue</p>
        <Sample />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KOTS.map((c) => (
          <div key={c.col} className="rounded-xl bg-muted p-1.5">
            <p className={`mb-1.5 rounded-md border px-2 py-1 text-center text-[10px] font-bold ${c.tone}`}>{c.col}</p>
            <div className="space-y-1.5">
              {c.tickets.map(([id, where, items, t]) => (
                <div key={id} className="rounded-lg border border-border bg-card p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold">{id}</span>
                    <span className="text-[9px] text-muted-foreground">{t}</span>
                  </div>
                  <p className="text-[9px] font-semibold text-primary">{where}</p>
                  <p className="mt-0.5 text-[9px] leading-snug text-muted-foreground">{items}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mk-float-a absolute -right-3 -top-4 flex items-center gap-1.5 rounded-full border border-mint-border bg-card px-3 py-1.5 text-[11px] font-bold text-mint shadow-lg sm:-right-6">
        <CheckCircle2 size={14} /> Order ready · Table 2
      </div>
    </div>
  )
}

const BARS = [38, 55, 46, 72, 64, 88, 100]
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Revenue bars with a P&L summary. */
export function ReportsMockup() {
  return (
    <div className="relative mx-auto w-full max-w-md rounded-2xl border border-border-strong bg-card p-5 shadow-2xl">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">Revenue · last 7 days</p>
          <p className="mt-0.5 text-2xl font-extrabold tracking-tight">₹2,84,600</p>
        </div>
        <div className="text-right">
          <span className="rounded-full bg-mint-bg px-2 py-0.5 text-[11px] font-bold text-mint">▲ 14.2%</span>
          <div className="mt-1">
            <Sample />
          </div>
        </div>
      </div>
      <div className="mt-5 flex h-32 items-end gap-2">
        {BARS.map((h, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div
              className="mk-bar w-full rounded-t-lg bg-gradient-to-t from-primary to-[#c0396b]"
              style={{ height: `${h}%`, '--mk-delay': `${i * 90}ms` } as CSSProperties}
            />
            <span className="text-[10px] text-muted-foreground">{DAYS[i]}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-4">
        {[
          ['Revenue', '₹2.85L', 'text-foreground'],
          ['Expenses + payroll', '₹1.72L', 'text-amber'],
          ['Net profit', '₹1.12L', 'text-mint'],
        ].map(([k, v, c]) => (
          <div key={k}>
            <p className="text-[10px] text-muted-foreground">{k}</p>
            <p className={`text-sm font-extrabold ${c}`}>{v}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
