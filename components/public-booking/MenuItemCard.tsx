import { UtensilsCrossed, ShoppingCart, type LucideIcon } from 'lucide-react'
import type { PublicMenuItem } from '@/lib/menu/public'
import { formatMoney } from '@/lib/format'

/** The food-card look shared by the full /food-menu grid (FoodMenuClient)
 *  and the homepage's "Menu Highlights" website section — one card design,
 *  not two implementations that can drift apart. */
export function MenuItemCard({
  item,
  currency,
  fallbackIcon: FallbackIcon = UtensilsCrossed,
}: {
  item: PublicMenuItem
  currency: string
  fallbackIcon?: LucideIcon
}) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm transition-all duration-300 hover:-translate-y-1.5 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/10">
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
            <div className="absolute inset-0 opacity-15 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] [background-size:16px_16px]" />
            <div className="rounded-2xl bg-card p-3 shadow-md border border-border/40 relative z-10 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
              <FallbackIcon className="h-6 w-6 text-primary/45 sm:h-8 sm:w-8" />
            </div>
            <span className="mt-2 hidden text-[10px] font-black text-muted-foreground/60 tracking-wider uppercase sm:block relative z-10">
              Premium Delicacy
            </span>
          </div>
        )}
      </div>

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

        <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2.5 sm:mt-4 sm:pt-4">
          <span className="hidden text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80 sm:inline">
            Price
          </span>
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-primary sm:text-lg">{formatMoney(item.price, currency)}</span>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors duration-300 group-hover:bg-primary group-hover:text-primary-foreground sm:size-8">
              <ShoppingCart className="size-3.5 sm:size-4" />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
