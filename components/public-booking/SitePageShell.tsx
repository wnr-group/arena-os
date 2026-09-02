import type { ReactNode } from 'react'
import { PublicNavbar } from './PublicNavbar'
import { OrderNavbar } from './OrderNavbar'
import { OrderCartProvider } from './OrderCartProvider'

/**
 * The navbar every non-homepage public page shares — /resources,
 * /book-type/[id], /book/[id], /b/[token], /food-menu. Centralizing it here
 * is what keeps the cart button showing up consistently on every page a
 * tenant sells food on, instead of each page deciding for itself and
 * drifting (which is how /resources ended up without one). `hasMenu` gates
 * the cart entirely: a tenant with no menu items never shows a cart button
 * anywhere, since there'd be nothing to add.
 */
export function SitePageShell({
  tenantName,
  icon,
  logoUrl,
  hasMenu,
  children,
}: {
  tenantName: string
  icon: ReactNode
  logoUrl?: string | null
  hasMenu: boolean
  children: ReactNode
}) {
  if (!hasMenu) {
    return (
      <>
        <PublicNavbar tenantName={tenantName} icon={icon} logoUrl={logoUrl} />
        {children}
      </>
    )
  }

  return (
    <OrderCartProvider>
      <OrderNavbar tenantName={tenantName} icon={icon} logoUrl={logoUrl} />
      {children}
    </OrderCartProvider>
  )
}
