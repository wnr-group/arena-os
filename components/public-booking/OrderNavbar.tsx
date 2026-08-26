'use client'

import type { ReactNode } from 'react'
import { PublicNavbar } from './PublicNavbar'
import { useOrderCart } from './OrderCartProvider'

/** Thin wrapper so any page with a cart (station order, /food-menu, the
 *  homepage's menu highlights) can show a live cart count on its navbar and
 *  open the drawer — PublicNavbar itself stays cart-agnostic for every other
 *  public page that renders it. Must be mounted inside an OrderCartProvider. */
export function OrderNavbar({
  tenantName,
  icon,
  logoUrl,
  topOffset,
}: {
  tenantName: string
  icon: ReactNode
  logoUrl?: string | null
  topOffset?: number
}) {
  const { cartCount, openCart } = useOrderCart()
  return (
    <PublicNavbar
      tenantName={tenantName}
      icon={icon}
      logoUrl={logoUrl}
      topOffset={topOffset}
      cartCount={cartCount}
      onCartClick={openCart}
    />
  )
}
