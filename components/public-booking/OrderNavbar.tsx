'use client'

import type { ReactNode } from 'react'
import { PublicNavbar } from './PublicNavbar'
import { useOrderCart } from './OrderCartProvider'

/** Thin wrapper so the /order page's navbar can show a live cart count and
 *  open the drawer — PublicNavbar itself stays cart-agnostic for every other
 *  public page that renders it. */
export function OrderNavbar({
  tenantName,
  icon,
  logoUrl,
}: {
  tenantName: string
  icon: ReactNode
  logoUrl?: string | null
}) {
  const { cartCount, openCart } = useOrderCart()
  return <PublicNavbar tenantName={tenantName} icon={icon} logoUrl={logoUrl} cartCount={cartCount} onCartClick={openCart} />
}
