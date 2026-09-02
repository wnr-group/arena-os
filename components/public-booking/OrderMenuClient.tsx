'use client'

import { useMemo, useState } from 'react'
import {
  Search,
  UtensilsCrossed,
  Pizza,
  Coffee,
  CupSoda,
  IceCream,
  Cake,
  Cookie,
  Soup,
  Wine,
  Beer,
  Salad,
  Sandwich,
  X,
} from 'lucide-react'
import type { PublicMenuItem } from '@/lib/menu/public'
import type { PublicTenant } from '@/lib/tenant/public'
import { useOrderCart } from './OrderCartProvider'
import { OrderableMenuItemCard } from './OrderableMenuItemCard'

export type OrderableMenuItem = PublicMenuItem & { discountedPrice: string | null }
export type OrderableMenuCategory = { id: string; name: string; items: OrderableMenuItem[] }

type CategoryIconType = typeof UtensilsCrossed

const CATEGORY_ICON_MAP: Record<string, CategoryIconType> = {
  drink: CupSoda,
  beverage: CupSoda,
  soft: CupSoda,
  shake: CupSoda,
  juice: CupSoda,
  coffee: Coffee,
  tea: Coffee,
  hot: Coffee,
  beer: Beer,
  wine: Wine,
  cocktail: Wine,
  bar: Wine,
  burger: Sandwich,
  sandwich: Sandwich,
  panini: Sandwich,
  wrap: Sandwich,
  pizza: Pizza,
  dessert: Cake,
  sweet: Cake,
  cake: Cake,
  pastry: Cake,
  'ice cream': IceCream,
  gelato: IceCream,
  snack: Cookie,
  bite: Cookie,
  finger: Cookie,
  fry: Cookie,
  fries: Cookie,
  soup: Soup,
  stew: Soup,
  ramen: Soup,
  noodle: Soup,
  salad: Salad,
  healthy: Salad,
  green: Salad,
}

function getCategoryIcon(name: string): CategoryIconType {
  const clean = name.toLowerCase()
  for (const [key, icon] of Object.entries(CATEGORY_ICON_MAP)) {
    if (clean.includes(key)) return icon
  }
  return UtensilsCrossed
}

/**
 * The ordering surface shared by /order/[stationToken] (QR-at-station) and
 * /food-menu (browse-and-order without a table) — browse, build a cart,
 * place the order. Cart state itself lives in OrderCartProvider (a
 * page-level context) rather than here, so the navbar's cart button — a
 * sibling in the tree, not a descendant — can show the live count and open
 * the drawer.
 */
export function OrderMenuClient({
  categories,
  tenant,
}: {
  categories: OrderableMenuCategory[]
  tenant: PublicTenant
}) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const { cart, addOrIncrement, decrementById } = useOrderCart()

  const totalItemsCount = useMemo(() => categories.reduce((sum, cat) => sum + cat.items.length, 0), [categories])

  const filteredData = useMemo(() => {
    const result = categories.map((cat) => {
      if (selectedCategoryId !== 'all' && cat.id !== selectedCategoryId) return { ...cat, items: [] }
      const items = cat.items.filter((item) => {
        if (!searchQuery.trim()) return true
        const q = searchQuery.toLowerCase()
        return item.name.toLowerCase().includes(q) || (item.description && item.description.toLowerCase().includes(q))
      })
      return { ...cat, items }
    })
    return result.filter((cat) => cat.items.length > 0)
  }, [categories, selectedCategoryId, searchQuery])

  return (
    <div className="space-y-10 pb-10">
      {/* Search bar */}
      <div className="relative mx-auto max-w-xl">
        <div className="relative group">
          <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <input
            type="text"
            placeholder="Search the menu..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-2xl border border-border/80 bg-card/75 py-4 pl-12 pr-10 text-sm shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/10 backdrop-blur-md"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Category filter buttons */}
      <div className="space-y-4">
        <div className="flex overflow-x-auto gap-3 pb-3 scrollbar-none snap-x snap-mandatory -mx-4 px-4 sm:mx-0 sm:px-0">
          <button
            type="button"
            onClick={() => setSelectedCategoryId('all')}
            className={`inline-flex items-center gap-2 rounded-2xl border px-5 py-3 text-sm font-bold transition-all duration-300 shrink-0 snap-start active:scale-95 ${
              selectedCategoryId === 'all'
                ? 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/20'
                : 'border-border/60 bg-card/60 text-foreground hover:border-primary/40 hover:bg-primary/5'
            }`}
          >
            <UtensilsCrossed className="h-4 w-4" />
            All Items
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-muted text-muted-foreground">
              {totalItemsCount}
            </span>
          </button>
          {categories.map((category) => {
            const Icon = getCategoryIcon(category.name)
            const isActive = selectedCategoryId === category.id
            return (
              <button
                type="button"
                key={category.id}
                onClick={() => setSelectedCategoryId(category.id)}
                className={`inline-flex items-center gap-2 rounded-2xl border px-5 py-3 text-sm font-bold transition-all duration-300 shrink-0 snap-start active:scale-95 ${
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/25'
                    : 'border-border/60 bg-card/60 text-foreground hover:border-primary/40 hover:bg-primary/5'
                }`}
              >
                <Icon className="h-4 w-4" />
                {category.name}
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                    isActive ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {category.items.length}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Menu items */}
      <div className="space-y-14 pt-4">
        {filteredData.length === 0 ? (
          <div className="py-20 text-center rounded-3xl border border-dashed border-border/80 bg-card/30 backdrop-blur-sm max-w-lg mx-auto">
            <UtensilsCrossed className="mx-auto h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-bold text-foreground">No menu items found</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">Try adjusting your search.</p>
          </div>
        ) : (
          filteredData.map((category) => (
            <div key={category.id} className="space-y-6">
              <div className="flex items-center gap-3 border-b border-border/40 pb-3">
                <div className="flex items-center justify-center size-9 rounded-xl bg-primary/5 text-primary">
                  {(() => {
                    const CategoryIcon = getCategoryIcon(category.name)
                    return <CategoryIcon size={18} />
                  })()}
                </div>
                <h3 className="text-xl font-black tracking-tight text-foreground">{category.name}</h3>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
                {category.items.map((item) => (
                  <OrderableMenuItemCard
                    key={item.id}
                    item={item}
                    currency={tenant.currency}
                    qty={cart[item.id]?.qty ?? 0}
                    onIncrement={() => addOrIncrement(item)}
                    onDecrement={() => decrementById(item.id)}
                    fallbackIcon={getCategoryIcon(category.name)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
