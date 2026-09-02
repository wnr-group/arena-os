import Link from 'next/link'
import { Boxes, Users } from 'lucide-react'
import type { PublicResourceType } from '@/lib/booking/public-availability'
import { formatMoney } from '@/lib/format'

/**
 * A type groups one or more actual bookable units, but the customer only
 * ever picks the type here — whichever unit is free for their chosen slot
 * is assigned automatically on the type's own booking page (/book-type/[id]),
 * so there's never a "which unit?" step to click through. Shared by /resources
 * and the website builder's "Featured Resources" homepage section, so both
 * ever show exactly one card design.
 */
export function ResourceTypeCard({ type, currency }: { type: PublicResourceType; currency: string }) {
  return (
    <Link
      href={`/book-type/${type.id}`}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
    >
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-primary/5">
        {type.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={type.imageUrl}
            alt={type.name}
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-primary/30">
            <Boxes size={32} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <p className="line-clamp-1 text-lg font-bold text-foreground transition group-hover:text-primary">
          {type.name}
        </p>
        <p className="mt-2 min-h-10 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {type.description ?? ''}
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          {type.capacity != null ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground/80">
              <Users size={12} /> Up to {type.capacity}
            </span>
          ) : (
            <span />
          )}
          <span className="text-sm font-bold text-primary">{formatMoney(type.hourlyRate, currency)} / hr</span>
        </div>
      </div>
    </Link>
  )
}
