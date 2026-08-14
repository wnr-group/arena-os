import { MapPin, Phone, type LucideIcon } from 'lucide-react'

const NAV_LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'resources', label: 'Resources' },
  { id: 'about', label: 'About' },
  { id: 'contact', label: 'Contact' },
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
    <footer id="contact" className="scroll-mt-16 border-t border-border bg-card/40">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <div className={`grid grid-cols-1 gap-8 ${hasContact ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon size={18} />
              </span>
              <span className="text-base font-bold tracking-tight">{tenantName}</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{industryLabel}</p>
          </div>

          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Quick links</p>
            <ul className="mt-3 space-y-2">
              {NAV_LINKS.map((link) => (
                <li key={link.id}>
                  <a href={`#${link.id}`} className="text-sm text-muted-foreground transition hover:text-foreground">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {hasContact && (
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Contact</p>
              <ul className="mt-3 space-y-2.5">
                {address && (
                  <li className="flex items-start gap-2 text-sm text-muted-foreground">
                    <MapPin size={15} className="mt-0.5 shrink-0" />
                    <span>{address}</span>
                  </li>
                )}
                {phone && (
                  <li className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone size={15} className="shrink-0" />
                    <a href={`tel:${phone}`} className="transition hover:text-foreground">
                      {phone}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-10 border-t border-border pt-6 text-center text-xs text-muted-foreground">
          © {year} {tenantName}. All rights reserved.
        </div>
      </div>
    </footer>
  )
}
