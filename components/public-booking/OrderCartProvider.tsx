'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { OrderableMenuItem } from './OrderMenuClient'

export type CartLine = {
  menuItemId: string
  name: string
  imageUrl: string | null
  unitPrice: number
  qty: number
  specialInstructions: string
}

type OrderCartContextValue = {
  cart: Record<string, CartLine>
  cartLines: CartLine[]
  cartCount: number
  cartTotal: number
  cartOpen: boolean
  openCart: () => void
  closeCart: () => void
  addOrIncrement: (item: OrderableMenuItem) => void
  incrementById: (menuItemId: string) => void
  decrementById: (menuItemId: string) => void
  removeLine: (menuItemId: string) => void
  updateNote: (menuItemId: string, text: string) => void
  clearCart: () => void
}

const OrderCartContext = createContext<OrderCartContextValue | null>(null)

export function useOrderCart() {
  const ctx = useContext(OrderCartContext)
  if (!ctx) throw new Error('useOrderCart must be used within an OrderCartProvider')
  return ctx
}

/**
 * Lifts the ordering cart out of OrderMenuClient into context so the navbar
 * (a sibling in the page tree, not a descendant) can show a live item count
 * and open the cart drawer — replaces the old bottom sticky-bar entry point.
 */
export function OrderCartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Record<string, CartLine>>({})
  const [cartOpen, setCartOpen] = useState(false)

  const cartLines = useMemo(() => Object.values(cart), [cart])
  const cartCount = useMemo(() => cartLines.reduce((sum, l) => sum + l.qty, 0), [cartLines])
  const cartTotal = useMemo(() => cartLines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0), [cartLines])

  function addOrIncrement(item: OrderableMenuItem) {
    if (!item.available) return
    setCart((prev) => {
      const existing = prev[item.id]
      const unitPrice = Number(item.discountedPrice ?? item.price)
      return {
        ...prev,
        [item.id]: existing
          ? { ...existing, qty: existing.qty + 1 }
          : { menuItemId: item.id, name: item.name, imageUrl: item.imageUrl, unitPrice, qty: 1, specialInstructions: '' },
      }
    })
  }

  function incrementById(menuItemId: string) {
    setCart((prev) => {
      const existing = prev[menuItemId]
      if (!existing) return prev
      return { ...prev, [menuItemId]: { ...existing, qty: existing.qty + 1 } }
    })
  }

  function decrementById(menuItemId: string) {
    setCart((prev) => {
      const existing = prev[menuItemId]
      if (!existing) return prev
      if (existing.qty <= 1) {
        const next = { ...prev }
        delete next[menuItemId]
        return next
      }
      return { ...prev, [menuItemId]: { ...existing, qty: existing.qty - 1 } }
    })
  }

  function removeLine(menuItemId: string) {
    setCart((prev) => {
      const next = { ...prev }
      delete next[menuItemId]
      return next
    })
  }

  function updateNote(menuItemId: string, text: string) {
    setCart((prev) => {
      const existing = prev[menuItemId]
      if (!existing) return prev
      return { ...prev, [menuItemId]: { ...existing, specialInstructions: text } }
    })
  }

  const value: OrderCartContextValue = {
    cart,
    cartLines,
    cartCount,
    cartTotal,
    cartOpen,
    openCart: () => setCartOpen(true),
    closeCart: () => setCartOpen(false),
    addOrIncrement,
    incrementById,
    decrementById,
    removeLine,
    updateNote,
    clearCart: () => setCart({}),
  }

  return <OrderCartContext.Provider value={value}>{children}</OrderCartContext.Provider>
}
