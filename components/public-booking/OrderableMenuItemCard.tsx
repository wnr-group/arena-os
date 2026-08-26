import { UtensilsCrossed, Plus, Minus, Flame, type LucideIcon } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { OrderableMenuItem } from './OrderMenuClient'

/**
 * The item card used everywhere a customer can add to cart — the full
 * /order/[stationToken] and /food-menu grids (via OrderMenuClient) and the
 * homepage "Menu Highlights" section (via MenuHighlightsClient). Adds a
 * "Sold out" state, a happy-hour strikethrough price, and a qty stepper.
 */
export function OrderableMenuItemCard({
  item,
  currency,
  qty,
  onIncrement,
  onDecrement,
  fallbackIcon: FallbackIcon = UtensilsCrossed,
}: {
  item: OrderableMenuItem
  currency: string
  qty: number
  onIncrement: () => void
  onDecrement: () => void
  fallbackIcon?: LucideIcon
}) {
  const hasDiscount = item.discountedPrice !== null && item.available
  const displayPrice = hasDiscount ? item.discountedPrice! : item.price

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm transition-all duration-300 ${
        item.available ? 'hover:-translate-y-1.5 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/10' : 'opacity-60'
      }`}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-muted sm:aspect-[16/11]">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.name}
            loading="lazy"
            className={`h-full w-full object-cover transition-transform duration-500 ease-out ${item.available ? 'group-hover:scale-105' : 'grayscale'}`}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-primary/5 via-accent/5 to-transparent text-primary/30">
            <div className="rounded-2xl bg-card p-3 shadow-md border border-border/40">
              <FallbackIcon className="h-6 w-6 text-primary/45 sm:h-8 sm:w-8" />
            </div>
          </div>
        )}
        {!item.available && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[1px]">
            <span className="rounded-full bg-foreground/90 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-background">
              Sold out
            </span>
          </div>
        )}
        {hasDiscount && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow">
            <Flame size={10} /> Happy Hour
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3 sm:p-5">
        <h4 className="font-bold text-foreground text-xs leading-snug tracking-tight line-clamp-2 sm:text-base sm:line-clamp-1">
          {item.name}
        </h4>

        {item.description ? (
          <p className="mt-1.5 hidden text-xs leading-relaxed text-muted-foreground line-clamp-2 flex-1 sm:block sm:text-sm">
            {item.description}
          </p>
        ) : (
          <div className="flex-1" />
        )}

        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/40 pt-2.5 sm:mt-4 sm:pt-4">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-black text-primary sm:text-lg">{formatMoney(displayPrice, currency)}</span>
            {hasDiscount && (
              <span className="text-xs text-muted-foreground line-through">{formatMoney(item.price, currency)}</span>
            )}
          </div>

          {!item.available ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Unavailable</span>
          ) : qty === 0 ? (
            <button
              type="button"
              onClick={onIncrement}
              className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition hover:opacity-90 active:scale-95"
            >
              <Plus size={13} /> Add
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-1">
              <button
                type="button"
                onClick={onDecrement}
                aria-label="Remove one"
                className="flex size-6 items-center justify-center rounded-full bg-background text-foreground shadow-sm active:scale-90"
              >
                <Minus size={12} />
              </button>
              <span className="min-w-4 text-center text-sm font-bold">{qty}</span>
              <button
                type="button"
                onClick={onIncrement}
                aria-label="Add one more"
                className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm active:scale-90"
              >
                <Plus size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
