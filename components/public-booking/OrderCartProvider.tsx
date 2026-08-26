'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OrderableMenuItem } from './OrderMenuClient'

export type CartLine = {
  menuItemId: string
  name: string
  imageUrl: string | null
  unitPrice: number
  qty: number
  specialInstructions: string
  hasDiscount: boolean
}

// Cart survives a refresh via localStorage — already scoped per tenant since
// each tenant is its own subdomain/origin, so no tenant id needs to be baked
// into the key. A cart left untouched past MAX_AGE_MS is dropped on next load
// rather than restored: prices/availability may have drifted, and the order
// is re-validated server-side regardless, but a week-old "cart" reappearing
// is more confusing than helpful.
const STORAGE_KEY = 'order-cart'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function loadStoredCart(): Record<string, CartLine> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { savedAt?: number; cart?: Record<string, CartLine> }
    if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) return {}
    return parsed.cart ?? {}
  } catch {
    return {}
  }
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
  // Starts empty so the server render and the client's first render match
  // (localStorage doesn't exist on the server) — the persisted cart, if any,
  // is loaded a moment later in the effect below.
  const [cart, setCart] = useState<Record<string, CartLine>>({})
  const [loaded, setLoaded] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)

  useEffect(() => {
    setCart(loadStoredCart())
    setLoaded(true)
  }, [])

  useEffect(() => {
    // Skip the pre-hydration pass (cart is still the empty initial value at
    // that point) — writing then would clobber a previously saved cart with
    // {} a split second before the real one loads.
    if (!loaded) return
    try {
      if (Object.keys(cart).length === 0) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), cart }))
      }
    } catch {
      // Private browsing / quota exceeded — cart still works for this tab,
      // it just won't survive a refresh.
    }
  }, [cart, loaded])

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
          : {
              menuItemId: item.id,
              name: item.name,
              imageUrl: item.imageUrl,
              unitPrice,
              qty: 1,
              specialInstructions: '',
              hasDiscount: item.discountedPrice !== null,
            },
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
