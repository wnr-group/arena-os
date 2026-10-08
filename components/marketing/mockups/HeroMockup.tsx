import { CalendarDays, CheckCircle2, LayoutDashboard, Receipt, ChefHat, Users, BarChart3, Boxes } from 'lucide-react'

type Tone = 'rose' | 'mint' | 'amber' | 'slate'

const TONE: Record<Tone, string> = {
  rose: 'bg-rose-bg text-rose border-rose-border',
  mint: 'bg-mint-bg text-mint border-mint-border',
  amber: 'bg-amber-bg text-amber border-amber-border',
  slate: 'bg-slate-bg text-slate border-slate-border',
}

/** Hours 10 AM → 10 PM across 12 columns; `s` is the 1-based start column. */
const ROWS: { name: string; blocks: { s: number; n: number; t: string; tone: Tone }[] }[] = [
  {
    name: 'PS5 · Station 1',
    blocks: [
      { s: 1, n: 3, t: 'Arjun · 3h', tone: 'rose' },
      { s: 5, n: 3, t: 'Walk-in · 01:12', tone: 'mint' },
      { s: 9, n: 3, t: 'Team Vortex', tone: 'amber' },
    ],
  },
  {
    name: 'PS5 · Station 2',
    blocks: [
      { s: 2, n: 2, t: 'Riya · 2h', tone: 'rose' },
      { s: 6, n: 4, t: 'Birthday · 4h', tone: 'amber' },
    ],
  },
  {
    name: 'Snooker · Table 1',
    blocks: [
      { s: 1, n: 2, t: 'Walk-in', tone: 'mint' },
      { s: 4, n: 3, t: 'Karan · 3h', tone: 'rose' },
      { s: 9, n: 2, t: 'Maintenance', tone: 'slate' },
    ],
  },
  {
    name: 'VR · Pod A',
    blocks: [
      { s: 3, n: 2, t: 'Sana · 2h', tone: 'rose' },
      { s: 7, n: 2, t: 'Walk-in · 00:34', tone: 'mint' },
      { s: 10, n: 3, t: 'Corporate', tone: 'amber' },
    ],
  },
]

const HOURS = ['10', '11', '12', '1', '2', '3', '4', '5', '6', '7', '8', '9']

const STATS = [
  { label: 'Bookings today', value: '42', delta: '+8' },
  { label: 'Revenue', value: '₹48,250', delta: '+12%' },
  { label: 'Utilisation', value: '78%', delta: '+5%' },
]

const SIDE_ICONS = [LayoutDashboard, CalendarDays, Receipt, ChefHat, Users, BarChart3, Boxes]

/** The hero's product shot: a tilted dashboard with floating status chips. */
export function HeroMockup() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl px-2 [perspective:1800px] sm:mt-20">
      {/* glow behind the frame */}
      <div className="pointer-events-none absolute inset-x-10 -bottom-10 top-10 rounded-[3rem] bg-gradient-to-r from-primary/30 via-[#c0396b]/25 to-[#d49a3a]/30 blur-3xl" />

      <div className="mk-card-glow relative overflow-hidden rounded-2xl border border-border-strong bg-card md:[transform:rotateX(5deg)]">
        {/* browser chrome */}
        <div className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2.5">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </div>
          <div className="mx-auto flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-mint" />
            <span className="truncate">your-venue.arenaos.app/bookings</span>
          </div>
          <span className="hidden text-[10px] font-medium uppercase tracking-wide text-subtle-foreground sm:block">
            Sample data
          </span>
        </div>

        <div className="flex">
          {/* sidebar */}
          <div className="hidden w-14 shrink-0 flex-col items-center gap-3 border-r border-border bg-accent py-4 sm:flex">
            {SIDE_ICONS.map((Icon, i) => (
              <span
                key={i}
                className={
                  i === 1
                    ? 'flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm'
                    : 'flex size-8 items-center justify-center rounded-lg text-accent-foreground/60'
                }
              >
                <Icon size={15} />
              </span>
            ))}
          </div>

          <div className="min-w-0 flex-1 p-4 sm:p-5">
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {STATS.map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-background p-2.5 sm:p-3">
                  <p className="truncate text-[10px] text-muted-foreground sm:text-xs">{s.label}</p>
                  <p className="mt-1 text-sm font-bold tracking-tight sm:text-xl">{s.value}</p>
                  <p className="text-[10px] font-semibold text-mint sm:text-xs">▲ {s.delta}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-border">
              <div className="grid grid-cols-[5.5rem_1fr] border-b border-border bg-muted text-[10px] text-muted-foreground sm:grid-cols-[8rem_1fr]">
                <span className="px-2 py-1.5 sm:px-3">Resource</span>
                <div className="grid grid-cols-12">
                  {HOURS.map((h) => (
                    <span key={h} className="py-1.5 text-center">
                      {h}
                    </span>
                  ))}
                </div>
              </div>
              {ROWS.map((row) => (
                <div
                  key={row.name}
                  className="grid grid-cols-[5.5rem_1fr] items-center border-b border-border last:border-0 sm:grid-cols-[8rem_1fr]"
                >
                  <span className="truncate px-2 py-2.5 text-[10px] font-medium sm:px-3 sm:text-xs">{row.name}</span>
                  <div className="grid grid-cols-12 gap-0.5 py-1.5 pr-1.5">
                    {row.blocks.map((b) => (
                      <span
                        key={b.s}
                        style={{ gridColumn: `${b.s} / span ${b.n}` }}
                        className={`truncate rounded-md border px-1 py-1 text-[9px] font-semibold sm:px-1.5 sm:text-[11px] ${TONE[b.tone]}`}
                      >
                        {b.t}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* floating chips */}
      <div className="mk-float-a absolute -right-1 top-24 hidden items-center gap-3 rounded-2xl border border-border bg-card/95 p-3 pr-5 shadow-xl backdrop-blur md:flex lg:-right-8">
        <span className="relative flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CalendarDays size={17} />
          <span className="absolute -right-0.5 -top-0.5 flex size-2.5">
            <span className="mk-ping absolute inline-flex size-full rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
          </span>
        </span>
        <div>
          <p className="text-xs font-bold">New online booking</p>
          <p className="text-[11px] text-muted-foreground">VR · Pod A · 7:00 PM</p>
        </div>
      </div>

      <div className="mk-float-b absolute -left-1 bottom-24 hidden rounded-2xl border border-border bg-card/95 p-3.5 shadow-xl backdrop-blur md:block lg:-left-8">
        <p className="text-[11px] font-medium text-muted-foreground">Revenue · 7 days</p>
        <p className="mt-0.5 text-lg font-extrabold tracking-tight">₹2,84,600</p>
        <svg viewBox="0 0 140 40" className="mt-1 h-9 w-36" fill="none" aria-hidden>
          <defs>
            <linearGradient id="mk-spark" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#8b2242" />
              <stop offset="1" stopColor="#d49a3a" />
            </linearGradient>
          </defs>
          <path
            className="mk-draw"
            d="M2 32 L22 26 L42 29 L62 18 L82 22 L102 10 L122 14 L138 4"
            stroke="url(#mk-spark)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="mk-float-a absolute bottom-6 right-6 hidden items-center gap-2.5 rounded-2xl border border-mint-border bg-card/95 px-3.5 py-2.5 shadow-xl backdrop-blur lg:flex">
        <CheckCircle2 size={18} className="text-mint" />
        <div>
          <p className="text-xs font-bold">Invoice paid · UPI</p>
          <p className="text-[11px] text-muted-foreground">GST bill sent · ₹796.50</p>
        </div>
      </div>
    </div>
  )
}
