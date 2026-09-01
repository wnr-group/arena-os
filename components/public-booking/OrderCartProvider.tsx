'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OrderableMenuItem } from './OrderMenuClient'
import { MAX_ORDER_ITEM_QTY } from '@/lib/orders/limits'

export type CartModifier = { groupName: string; optionId: string; optionName: string; priceDelta: number }
export type CartLine = {
  /** Cart identity — menuItemId alone for an unmodified line, or menuItemId
   *  plus the sorted chosen option ids for a modified one (see cartLineKey),
   *  so "burger, no onions" and "burger, extra cheese" stay separate lines
   *  instead of merging into one qty. The Record below is keyed by this,
   *  NOT by menuItemId — a menu item with modifier groups can have several
   *  lines. */
  key: string
  menuItemId: string
  name: string
  imageUrl: string | null
  unitPrice: number
  qty: number
  specialInstructions: string
  hasDiscount: boolean
  modifiers: CartModifier[]
}

function cartLineKey(menuItemId: string, optionIds: string[]): string {
  return [menuItemId, ...[...optionIds].sort()].join('::')
}

/** Which table/station (if any) the cart is for — set once, at the QR-scan
 *  entry point, then carried silently across every other page the customer
 *  browses afterward (see the `station` prop below). */
export type CartStation = { token: string; name: string; hasActiveBooking: boolean }

/** Which device/resource booking (if any) the cart should attach to — set
 *  once, from the "Add food to your visit" nudge on the booking confirmation
 *  page (/food-menu?booking=<confirmationToken>), then carried the same way
 *  `station` is so it survives the navigation to /checkout. Mutually
 *  exclusive with `station` in practice (a table-QR order already attaches
 *  to its own active booking via the station), but kept as an independent
 *  field rather than folded into CartStation since there's no table/resource
 *  involved here at all. */
export type CartBooking = { token: string; bookingNumber: string }

// Cart (and station/booking context) survive a refresh via localStorage —
// already scoped per tenant since each tenant is its own subdomain/origin,
// so no tenant id needs to be baked into the key. Left untouched past
// MAX_AGE_MS, each is dropped on next load rather than restored:
// prices/availability may have drifted, and the order is re-validated
// server-side regardless, but a week-old "cart" reappearing is more
// confusing than helpful.
const CART_STORAGE_KEY = 'order-cart'
const STATION_STORAGE_KEY = 'order-station'
const BOOKING_STORAGE_KEY = 'order-booking'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function loadStoredCart(): Record<string, CartLine> {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { savedAt?: number; cart?: Record<string, CartLine> }
    if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) return {}
    return parsed.cart ?? {}
  } catch {
    return {}
  }
}

function loadStoredStation(): CartStation | null {
  try {
    const raw = window.localStorage.getItem(STATION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { savedAt?: number; station?: CartStation }
    if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) return null
    return parsed.station ?? null
  } catch {
    return null
  }
}

function loadStoredBooking(): CartBooking | null {
  try {
    const raw = window.localStorage.getItem(BOOKING_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { savedAt?: number; booking?: CartBooking }
    if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) return null
    return parsed.booking ?? null
  } catch {
    return null
  }
}

type OrderCartContextValue = {
  cart: Record<string, CartLine>
  cartLines: CartLine[]
  cartCount: number
  cartTotal: number
  /** The table this order is for, or null for pickup/takeaway. Read by the
   *  /checkout page — never trusted at order-placement time, which re-derives
   *  everything server-side from the token alone. */
  station: CartStation | null
  /** The device/resource booking this order should attach to (the
   *  add-food-to-your-visit nudge), or null. Same never-trusted-at-submit-time
   *  discipline as `station` — placeOnlineOrder re-resolves it from the token. */
  booking: CartBooking | null
  addOrIncrement: (item: OrderableMenuItem) => void
  /** Adds a new line for an item WITH chosen modifiers, or increments the
   *  existing line if this exact combination is already in the cart — see
   *  cartLineKey. For an item with no modifier groups, use addOrIncrement. */
  addWithModifiers: (item: OrderableMenuItem, modifiers: CartModifier[]) => void
  /** All four of these take a cart LINE's `key` (not menuItemId — a menu
   *  item with modifier groups can have several distinct lines). */
  incrementById: (key: string) => void
  decrementById: (key: string) => void
  removeLine: (key: string) => void
  updateNote: (key: string, text: string) => void
  clearCart: () => void
  /** Drops a booking attachment that turned out to be stale (the booking was
   *  completed/cancelled since the nudge link was first opened) — called by
   *  CheckoutClient after re-checking with the server, never assumed true
   *  just because it was cached. */
  clearBooking: () => void
}

const OrderCartContext = createContext<OrderCartContextValue | null>(null)

export function useOrderCart() {
  const ctx = useContext(OrderCartContext)
  if (!ctx) throw new Error('useOrderCart must be used within an OrderCartProvider')
  return ctx
}

/**
 * Lifts the ordering cart out of OrderMenuClient into context so the navbar
 * (a sibling in the page tree, not a descendant) can show a live item count,
 * and so a click on the cart button can navigate to /checkout — a standalone
 * route, not a drawer overlaid on the current page — with the cart already
 * loaded, because it too mounts this same provider and hydrates from the
 * same localStorage.
 */
export function OrderCartProvider({
  children,
  station: incomingStation,
  booking: incomingBooking,
}: {
  children: ReactNode
  /** Passed only by the QR-at-station entry point (/order/[stationToken]) —
   *  every other page omits this so an already-set station survives a visit
   *  to, say, /food-menu without being silently cleared back to pickup. */
  station?: CartStation
  /** Passed only by /food-menu when reached via the booking confirmation
   *  page's "Add food to your visit" nudge (?booking=<token>) — every other
   *  entry point omits this so an already-set booking survives further
   *  browsing the same way `station` does. */
  booking?: CartBooking
}) {
  // Both start empty/null so the server render and the client's first render
  // match (localStorage doesn't exist on the server) — the persisted values,
  // if any, are loaded a moment later in the effect below.
  const [cart, setCart] = useState<Record<string, CartLine>>({})
  const [station, setStation] = useState<CartStation | null>(null)
  const [booking, setBooking] = useState<CartBooking | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setCart(loadStoredCart())
    setStation(loadStoredStation())
    setBooking(loadStoredBooking())
    setLoaded(true)
  }, [])

  // A page that DOES know its station (only the QR entry point) always wins
  // over whatever was previously stored — scanning a different table's code
  // must move the order there, not silently keep billing the old one.
  useEffect(() => {
    if (!incomingStation) return
    setStation(incomingStation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingStation?.token, incomingStation?.name, incomingStation?.hasActiveBooking])

  // Same "fresh entry point always wins" rule as station, for the
  // add-food-to-your-visit nudge.
  useEffect(() => {
    if (!incomingBooking) return
    setBooking(incomingBooking)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingBooking?.token, incomingBooking?.bookingNumber])

  useEffect(() => {
    // Skip the pre-hydration pass (cart is still the empty initial value at
    // that point) — writing then would clobber a previously saved cart with
    // {} a split second before the real one loads.
    if (!loaded) return
    try {
      if (Object.keys(cart).length === 0) {
        window.localStorage.removeItem(CART_STORAGE_KEY)
      } else {
        window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), cart }))
      }
    } catch {
      // Private browsing / quota exceeded — cart still works for this tab,
      // it just won't survive a refresh.
    }
  }, [cart, loaded])

  useEffect(() => {
    if (!loaded) return
    try {
      if (!station) {
        window.localStorage.removeItem(STATION_STORAGE_KEY)
      } else {
        window.localStorage.setItem(STATION_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), station }))
      }
    } catch {
      // Same private-browsing/quota caveat as the cart above.
    }
  }, [station, loaded])

  useEffect(() => {
    if (!loaded) return
    try {
      if (!booking) {
        window.localStorage.removeItem(BOOKING_STORAGE_KEY)
      } else {
        window.localStorage.setItem(BOOKING_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), booking }))
      }
    } catch {
      // Same private-browsing/quota caveat as the cart above.
    }
  }, [booking, loaded])

  const cartLines = useMemo(() => Object.values(cart), [cart])
  const cartCount = useMemo(() => cartLines.reduce((sum, l) => sum + l.qty, 0), [cartLines])
  const cartTotal = useMemo(() => cartLines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0), [cartLines])

  function addOrIncrement(item: OrderableMenuItem) {
    if (!item.available) return
    const key = cartLineKey(item.id, [])
    setCart((prev) => {
      const existing = prev[key]
      if (existing && existing.qty >= MAX_ORDER_ITEM_QTY) return prev
      const unitPrice = Number(item.discountedPrice ?? item.price)
      return {
        ...prev,
        [key]: existing
          ? { ...existing, qty: existing.qty + 1 }
          : {
              key,
              menuItemId: item.id,
              name: item.name,
              imageUrl: item.imageUrl,
              unitPrice,
              qty: 1,
              specialInstructions: '',
              hasDiscount: item.discountedPrice !== null,
              modifiers: [],
            },
      }
    })
  }

  // A modifier delta is never discounted by happy hour — only the base item
  // is (see item.discountedPrice), same rule createOrderCore enforces
  // server-side. Folded into unitPrice once, at add time, rather than
  // recomputed on every render — same discipline addOrIncrement already
  // follows for the happy-hour price itself.
  function addWithModifiers(item: OrderableMenuItem, modifiers: CartModifier[]) {
    if (!item.available) return
    const key = cartLineKey(item.id, modifiers.map((m) => m.optionId))
    setCart((prev) => {
      const existing = prev[key]
      if (existing && existing.qty >= MAX_ORDER_ITEM_QTY) return prev
      const deltaSum = modifiers.reduce((sum, m) => sum + m.priceDelta, 0)
      const unitPrice = Number(item.discountedPrice ?? item.price) + deltaSum
      return {
        ...prev,
        [key]: existing
          ? { ...existing, qty: existing.qty + 1 }
          : {
              key,
              menuItemId: item.id,
              name: item.name,
              imageUrl: item.imageUrl,
              unitPrice,
              qty: 1,
              specialInstructions: '',
              hasDiscount: item.discountedPrice !== null,
              modifiers,
            },
      }
    })
  }

  // Clamped at MAX_ORDER_ITEM_QTY — the same limit lib/actions/public-orders.ts's
  // zod schema enforces server-side, so the '+' button can never build a line
  // placeOnlineOrder will then reject wholesale at checkout.
  function incrementById(key: string) {
    setCart((prev) => {
      const existing = prev[key]
      if (!existing || existing.qty >= MAX_ORDER_ITEM_QTY) return prev
      return { ...prev, [key]: { ...existing, qty: existing.qty + 1 } }
    })
  }

  function decrementById(key: string) {
    setCart((prev) => {
      const existing = prev[key]
      if (!existing) return prev
      if (existing.qty <= 1) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: { ...existing, qty: existing.qty - 1 } }
    })
  }

  function removeLine(key: string) {
    setCart((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function updateNote(key: string, text: string) {
    setCart((prev) => {
      const existing = prev[key]
      if (!existing) return prev
      return { ...prev, [key]: { ...existing, specialInstructions: text } }
    })
  }

  const value: OrderCartContextValue = {
    cart,
    cartLines,
    cartCount,
    cartTotal,
    station,
    booking,
    addOrIncrement,
    addWithModifiers,
    incrementById,
    decrementById,
    removeLine,
    updateNote,
    clearCart: () => setCart({}),
    clearBooking: () => setBooking(null),
  }

  return <OrderCartContext.Provider value={value}>{children}</OrderCartContext.Provider>
}
