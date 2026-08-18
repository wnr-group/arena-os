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
  Sparkles,
  X
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

function getItemTags(item: PublicMenuItem) {
  const tags: { label: string; className: string; icon: CategoryIconType }[] = []
  const text = `${item.name} ${item.description ?? ''}`.toLowerCase()

  if (text.includes('spicy') || text.includes('chili') || text.includes('hot') || text.includes('jalapeno') || text.includes('jalapeño')) {
    tags.push({
      label: 'Spicy',
      className: 'bg-red-500/10 text-red-500 border border-red-500/20',
      icon: Flame,
    })
  }
  if (
    text.includes('signature') ||
    text.includes('chef') ||
    text.includes('bestseller') ||
    text.includes('popular') ||
    text.includes('must try') ||
    text.includes('special')
  ) {
    tags.push({
      label: 'Signature',
      className: 'bg-amber-500/10 text-amber-500 border border-amber-500/20',
      icon: Sparkles,
    })
  }
  return tags
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
        <div className="relative">
          <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search for delicious food, drinks, desserts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-2xl border border-border bg-card py-4 pl-12 pr-10 text-sm shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Category filter buttons */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Menu Categories</h2>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {categories.length} Categories
          </span>
        </div>

        {/* Categories as filter buttons */}
        <div className="flex flex-wrap gap-2">
          {/* "All" filter button */}
          <button
            type="button"
            onClick={() => setSelectedCategoryId('all')}
            className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-300 ${
              selectedCategoryId === 'all'
                ? 'border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                : 'border-border bg-card text-foreground hover:border-primary/40 hover:bg-primary/5'
            }`}
          >
            <UtensilsCrossed className="h-4 w-4" />
            All Items
            <span className="text-xs font-normal opacity-75">{totalItemsCount}</span>
          </button>

          {/* Individual category filter buttons */}
          {categories.map((category) => {
            const Icon = getCategoryIcon(category.name)
            const isActive = selectedCategoryId === category.id
            return (
              <button
                type="button"
                key={category.id}
                onClick={() => setSelectedCategoryId(category.id)}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-300 ${
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                    : 'border-border bg-card text-foreground hover:border-primary/40 hover:bg-primary/5'
                }`}
              >
                <Icon className="h-4 w-4" />
                {category.name}
                <span className="text-xs font-normal opacity-75">{category.items.length}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Menu items display */}
      <div className="space-y-12 pt-4">
        {filteredData.length === 0 ? (
          <div className="py-16 text-center">
            <UtensilsCrossed className="mx-auto h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-bold text-foreground">No menu items found</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Try adjusting your search query or selecting a different category.
            </p>
          </div>
        ) : (
          filteredData.map((category) => (
            <div key={category.id} className="space-y-6">
              <div className="flex items-center gap-3">
                <h3 className="text-xl font-bold tracking-tight text-foreground">{category.name}</h3>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                  {category.items.length}
                </span>
              </div>

              {/* Grid of food cards — 2-up on mobile like Zomato/Swiggy, roomier cards on desktop */}
              <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
                {category.items.map((item) => {
                  const tags = getItemTags(item)
                  const fallbackIcon = getCategoryIcon(category.name)
                  const FallbackIconComponent = fallbackIcon

                  return (
                    <div
                      key={item.id}
                      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_12px_24px_rgba(124,58,237,0.06)] sm:rounded-2xl"
                    >
                      {/* Image container */}
                      <div className="relative aspect-square w-full overflow-hidden bg-muted sm:aspect-[16/10] lg:aspect-[4/3]">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.name}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                          />
                        ) : (
                          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-primary/5 via-accent/5 to-transparent text-primary/30">
                            <div className="rounded-xl bg-card p-2 shadow-sm border border-border/40 sm:rounded-2xl sm:p-3">
                              <FallbackIconComponent className="h-5 w-5 text-primary/40 sm:h-8 sm:w-8" />
                            </div>
                            <span className="mt-1.5 hidden text-xs font-medium text-muted-foreground/60 tracking-wide uppercase sm:mt-2 sm:block">
                              Delicious Dish
                            </span>
                          </div>
                        )}

                        {/* Badges overlay */}
                        {tags.length > 0 && (
                          <div className="absolute left-1.5 top-1.5 flex flex-wrap gap-1 sm:left-3 sm:top-3 sm:gap-1.5">
                            {tags.slice(0, 1).map((tag, idx) => {
                              const TagIcon = tag.icon
                              return (
                                <span
                                  key={idx}
                                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider backdrop-blur-md sm:px-2.5 sm:py-1 sm:text-xs ${tag.className}`}
                                >
                                  <TagIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                                  <span className="hidden sm:inline">{tag.label}</span>
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </div>

                      {/* Content block */}
                      <div className="flex flex-1 flex-col p-2.5 sm:p-5 lg:p-6">
                        <h4 className="font-bold text-foreground text-xs leading-snug tracking-tight transition-colors duration-300 line-clamp-2 group-hover:text-primary sm:text-base sm:line-clamp-1 lg:text-lg">
                          {item.name}
                        </h4>

                        {item.description ? (
                          <p className="mt-1 hidden text-sm leading-relaxed text-muted-foreground line-clamp-2 flex-1 sm:mt-2 sm:block lg:text-base">
                            {item.description}
                          </p>
                        ) : (
                          <p className="mt-1 hidden text-sm leading-relaxed text-muted-foreground/50 italic flex-1 sm:mt-2 sm:block lg:text-base">
                            No description available.
                          </p>
                        )}

                        {/* Price details bar */}
                        <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5 sm:mt-4 sm:pt-4 lg:mt-5 lg:pt-5">
                          <span className="hidden text-xs font-semibold uppercase tracking-wider text-muted-foreground/80 sm:inline">
                            Price
                          </span>
                          <span className="text-sm font-extrabold text-primary sm:text-lg lg:text-xl">
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
