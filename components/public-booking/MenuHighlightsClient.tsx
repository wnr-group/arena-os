'use client'

import { useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useOrderCart } from './OrderCartProvider'
import { OrderableMenuItemCard } from './OrderableMenuItemCard'
import { ModifierPickerSheet } from './ModifierPickerSheet'
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
  const { cartLines, addOrIncrement, addWithModifiers, decrementById } = useOrderCart()
  const [pickerItem, setPickerItem] = useState<OrderableMenuItem | null>(null)

  // Total qty for one menu item across every cart line — see OrderMenuClient's
  // identical qtyByMenuItem for why this is a sum, not one line's qty.
  const qtyByMenuItem = useMemo(() => {
    const map = new Map<string, number>()
    for (const line of cartLines) map.set(line.menuItemId, (map.get(line.menuItemId) ?? 0) + line.qty)
    return map
  }, [cartLines])

  return (
    <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
      {items.map((item) => (
        <OrderableMenuItemCard
          key={item.id}
          item={item}
          currency={currency}
          qty={qtyByMenuItem.get(item.id) ?? 0}
          onIncrement={() => addOrIncrement(item)}
          onDecrement={() => decrementById(item.id)}
          onCustomize={item.modifierGroups.length > 0 ? () => setPickerItem(item) : undefined}
          fallbackIcon={fallbackIcon}
        />
      ))}

      {pickerItem && (
        <ModifierPickerSheet
          item={pickerItem}
          currency={currency}
          onClose={() => setPickerItem(null)}
          onConfirm={(modifiers) => {
            addWithModifiers(pickerItem, modifiers)
            setPickerItem(null)
          }}
        />
      )}
    </div>
  )
}
