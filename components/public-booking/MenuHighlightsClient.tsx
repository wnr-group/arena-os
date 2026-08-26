'use client'

import type { LucideIcon } from 'lucide-react'
import { useOrderCart } from './OrderCartProvider'
import { OrderableMenuItemCard } from './OrderableMenuItemCard'
import type { OrderableMenuItem } from './OrderMenuClient'

/**
 * The cart-aware grid behind the homepage's "Menu Highlights" section
 * (both the default TenantHome and the website-builder's 'menu' section) —
 * a client island so it can read/write the page-level OrderCartProvider,
 * while the section itself stays a server component fetching its own data.
 */
export function MenuHighlightsClient({
  items,
  currency,
  fallbackIcon,
}: {
  items: OrderableMenuItem[]
  currency: string
  fallbackIcon?: LucideIcon
}) {
  const { cart, addOrIncrement, decrementById } = useOrderCart()

  return (
    <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
      {items.map((item) => (
        <OrderableMenuItemCard
          key={item.id}
          item={item}
          currency={currency}
          qty={cart[item.id]?.qty ?? 0}
          onIncrement={() => addOrIncrement(item)}
          onDecrement={() => decrementById(item.id)}
          fallbackIcon={fallbackIcon}
        />
      ))}
    </div>
  )
}
