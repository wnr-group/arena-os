'use client'

import { useState, useMemo } from 'react'
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
  Flame,
  Wine,
  Beer,
  Salad,
  Sandwich,
  X,
} from 'lucide-react'
import type { PublicMenuCategory, PublicMenuItem } from '@/lib/menu/public'
import type { PublicTenant } from '@/lib/tenant/public'
import { formatMoney } from '@/lib/format'

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
    if (clean.includes(key)) {
      return icon
    }
  }
  return UtensilsCrossed
}

const CATEGORY_THEME = {
  active: 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/25',
  hover: 'hover:border-primary/40 hover:bg-primary/5',
}

export function FoodMenuClient({
  categories,
  tenant,
}: {
  categories: PublicMenuCategory[]
  tenant: PublicTenant
}) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')

  // Calculate total items count
  const totalItemsCount = useMemo(() => {
    return categories.reduce((sum, cat) => sum + cat.items.length, 0)
  }, [categories])

  // Filter items based on category selection and search query
  const filteredData = useMemo(() => {
    const result = categories.map((cat) => {
      // If we are filtering by a specific category, verify it matches
      if (selectedCategoryId !== 'all' && cat.id !== selectedCategoryId) {
        return { ...cat, items: [] }
      }

      // Filter category items by search query
      const filteredItems = cat.items.filter((item) => {
        if (!searchQuery.trim()) return true
        const query = searchQuery.toLowerCase()
        return (
          item.name.toLowerCase().includes(query) ||
          (item.description && item.description.toLowerCase().includes(query))
        )
      })

      return {
        ...cat,
        items: filteredItems,
      }
    })

    // Remove categories that ended up with no items
    return result.filter((cat) => cat.items.length > 0)
  }, [categories, selectedCategoryId, searchQuery])

  return (
    <div className="space-y-10">
      {/* Search and Quick Filters bar */}
      <div className="relative mx-auto max-w-xl">
        <div className="relative group">
          <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <input
            type="text"
            placeholder="Search for delicious food, drinks, desserts..."
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
        <div className="flex items-center justify-between px-1">
          <h2 className="text-lg font-black tracking-tight text-foreground/90">Categories</h2>
          <span className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-widest bg-muted px-2.5 py-1 rounded-md">
            {categories.length} Sections
          </span>
        </div>

        {/* Categories as filter buttons — horizontal smooth scroll */}
        <div className="flex overflow-x-auto gap-3 pb-3 scrollbar-none snap-x snap-mandatory -mx-4 px-4 sm:mx-0 sm:px-0">
          {/* "All" filter button */}
          <button
            type="button"
            onClick={() => setSelectedCategoryId('all')}
            className={`inline-flex items-center gap-2 rounded-2xl border px-5 py-3 text-sm font-bold transition-all duration-300 shrink-0 snap-start active:scale-95 ${
              selectedCategoryId === 'all'
                ? 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/20 scale-[1.01]'
                : 'border-border/60 bg-card/60 text-foreground hover:border-primary/40 hover:bg-primary/5'
            }`}
          >
            <UtensilsCrossed className="h-4 w-4" />
            All Items
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
              selectedCategoryId === 'all' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}>{totalItemsCount}</span>
          </button>

          {/* Individual category filter buttons */}
          {categories.map((category) => {
            const Icon = getCategoryIcon(category.name)
            const isActive = selectedCategoryId === category.id
            const theme = CATEGORY_THEME
            return (
              <button
                type="button"
                key={category.id}
                onClick={() => setSelectedCategoryId(category.id)}
                className={`inline-flex items-center gap-2 rounded-2xl border px-5 py-3 text-sm font-bold transition-all duration-300 shrink-0 snap-start active:scale-95 ${
                  isActive
                    ? `${theme.active} scale-[1.01]`
                    : `border-border/60 bg-card/60 text-foreground ${theme.hover}`
                }`}
              >
                <Icon className="h-4 w-4" />
                {category.name}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                  isActive ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}>{category.items.length}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Menu items display */}
      <div className="space-y-14 pt-4">
        {filteredData.length === 0 ? (
          <div className="py-20 text-center rounded-3xl border border-dashed border-border/80 bg-card/30 backdrop-blur-sm max-w-lg mx-auto">
            <UtensilsCrossed className="mx-auto h-12 w-12 text-muted-foreground/30 animate-pulse" />
            <h3 className="mt-4 text-lg font-bold text-foreground">No menu items found</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
              We couldn&apos;t find anything matching your query. Try adjusting filters or typing something else.
            </p>
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
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">
                  {category.items.length}
                </span>
              </div>

              {/* Grid of food cards */}
              <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
                {category.items.map((item) => {
                  const fallbackIcon = getCategoryIcon(category.name)
                  const FallbackIconComponent = fallbackIcon

                  return (
                    <div
                      key={item.id}
                      className="group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm transition-all duration-300 hover:-translate-y-1.5 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/10"
                    >
                      {/* Image container */}
                      <div className="relative aspect-square w-full overflow-hidden bg-muted sm:aspect-[16/11]">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.name}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                          />
                        ) : (
                          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-primary/5 via-accent/5 to-transparent text-primary/30 relative">
                            {/* Visual background grid texture */}
                            <div className="absolute inset-0 opacity-15 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] [background-size:16px_16px]" />
                            <div className="rounded-2xl bg-card p-3 shadow-md border border-border/40 relative z-10 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
                              <FallbackIconComponent className="h-6 w-6 text-primary/45 sm:h-8 sm:w-8" />
                            </div>
                            <span className="mt-2 hidden text-[10px] font-black text-muted-foreground/60 tracking-wider uppercase sm:block relative z-10">
                              Premium Delicacy
                            </span>
                          </div>
                        )}

                      </div>

                      {/* Content block */}
                      <div className="flex flex-1 flex-col p-3 sm:p-5">
                        <h4 className="font-bold text-foreground text-xs leading-snug tracking-tight transition-colors duration-300 line-clamp-2 group-hover:text-primary sm:text-base sm:line-clamp-1">
                          {item.name}
                        </h4>

                        {item.description ? (
                          <p className="mt-1.5 hidden text-xs leading-relaxed text-muted-foreground line-clamp-2 flex-1 sm:block sm:text-sm">
                            {item.description}
                          </p>
                        ) : (
                          <p className="mt-1.5 hidden text-xs leading-relaxed text-muted-foreground/50 italic flex-1 sm:block sm:text-sm">
                            Freshly prepared with quality ingredients.
                          </p>
                        )}

                        {/* Price details bar */}
                        <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2.5 sm:mt-4 sm:pt-4">
                          <span className="hidden text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80 sm:inline">
                            Price
                          </span>
                          <span className="text-sm font-black text-primary sm:text-lg">
                            {formatMoney(item.price, tenant.currency)}
                          </span>
                        </div>

                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

    </div>
  )
}

