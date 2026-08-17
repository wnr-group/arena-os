import { ArrowRight, MapPin, Phone, type LucideIcon } from 'lucide-react'

const NAV_LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'menu', label: 'Menu' },
  { id: 'resources', label: 'Resources' },
  { id: 'about', label: 'About' },
]

export function PublicFooter({
  tenantName,
  industryLabel,
  icon: Icon,
  address,
  phone,
}: {
  tenantName: string
  industryLabel: string
  icon: LucideIcon
  address: string | null
  phone: string | null
}) {
  const year = new Date().getFullYear()
  const hasContact = Boolean(address || phone)

  return (
    <footer
      id="contact"
      className="scroll-mt-16 border-t border-border bg-gradient-to-b from-background via-card/30 to-muted/20 relative overflow-hidden"
    >
      {/* Subtle background glow */}
      <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[100px]" />

      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16 relative z-10">
        {/* CTA banner */}
        <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-gradient-to-r from-card to-muted/40 p-6 shadow-[0_8px_30px_rgb(0,0,0,0.015)] sm:flex sm:items-center sm:justify-between sm:p-8 group">
          {/* Subtle internal glowing decoration */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-primary/10 blur-3xl transition-transform duration-700 group-hover:scale-110"
          />
          <div className="relative z-10">
            <h3 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Ready to visit {tenantName}?
            </h3>
            <p className="mt-1.5 text-sm text-muted-foreground max-w-md font-medium">
              Reserve your spot online — it only takes a minute to secure your preferred slot.
            </p>
          </div>
          <a
            href="#book"
            className="relative overflow-hidden mt-5 inline-flex items-center gap-2 rounded-xl bg-primary hover:bg-primary-hover px-5 py-3 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 sm:mt-0 z-10 group/btn"
          >
            {/* Shimmer overlay effect */}
            <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full group-hover/btn:translate-x-full transition-transform duration-1000 ease-out" />
            
            <span>Book Now</span>
            <ArrowRight size={15} className="transition-transform duration-300 group-hover/btn:translate-x-0.5" />
          </a>
        </div>

        {/* Columns */}
        <div className="mt-12 grid grid-cols-1 gap-10 sm:grid-cols-3">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary to-violet-500 text-primary-foreground shadow-lg shadow-primary/20 ring-2 ring-primary/10">
                <Icon size={18} />
              </span>
              <span className="text-base font-bold tracking-tight bg-gradient-to-r from-foreground to-muted-foreground/80 bg-clip-text text-transparent">
                {tenantName}
              </span>
            </div>
            <p className="mt-4 max-w-xs text-sm text-muted-foreground leading-relaxed">
              {industryLabel} — open for walk-ins and online bookings alike.
            </p>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-foreground/80">Explore</h4>
            <ul className="mt-4 space-y-3">
              {NAV_LINKS.map((link) => (
                <li key={link.id}>
                  <a
                    href={`#${link.id}`}
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-all duration-200 hover:text-primary hover:translate-x-0.5"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {hasContact && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-foreground/80">Contact</h4>
              <ul className="mt-4 space-y-3">
                {address && (
                  <li className="flex items-start gap-3 text-sm text-muted-foreground">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-card text-primary shadow-sm">
                      <MapPin size={14} />
                    </span>
                    <span className="pt-1 leading-relaxed">{address}</span>
                  </li>
                )}
                {phone && (
                  <li className="flex items-center gap-3 text-sm text-muted-foreground">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-card text-primary shadow-sm">
                      <Phone size={14} />
                    </span>
                    <a href={`tel:${phone}`} className="pt-0.5 transition-colors duration-200 hover:text-primary">
                      {phone}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-border/60 pt-8 text-center sm:flex-row sm:text-left">
          <p className="text-xs text-muted-foreground">
            &copy; {year} {tenantName}. All rights reserved.
          </p>
          <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/60 backdrop-blur-sm px-3.5 py-1 text-xs text-muted-foreground shadow-sm">
            <span>Powered by</span>
            <span className="font-semibold text-foreground bg-gradient-to-r from-primary to-violet-500 bg-clip-text text-transparent">
              Arena OS
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}
