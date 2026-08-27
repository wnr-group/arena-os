'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { PublicNavbar } from './PublicNavbar'
import { useOrderCart } from './OrderCartProvider'

/** Thin wrapper so any page with a cart (station order, /food-menu, the
 *  homepage's menu highlights) can show a live cart count on its navbar and
 *  jump straight to /checkout — PublicNavbar itself stays cart-agnostic for
 *  every other public page that renders it. Must be mounted inside an
 *  OrderCartProvider.
 *
 *  Also surfaces the "My Booking" hub (M14 #7, v2 follow-up, extended to
 *  device bookings): always the phone-lookup page (/track), which shows the
 *  customer's food orders AND device bookings together once they enter their
 *  number — never a silent shortcut straight to one order, since that would
 *  skip the booking half entirely. */
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
  const { cartCount } = useOrderCart()
  const router = useRouter()
  return (
    <PublicNavbar
      tenantName={tenantName}
      icon={icon}
      logoUrl={logoUrl}
      topOffset={topOffset}
      cartCount={cartCount}
      onCartClick={() => router.push('/checkout')}
      myBookingHref="/track"
    />
  )
}
