import Link from 'next/link'
import { Boxes, Users } from 'lucide-react'
import type { PublicResourceType, PublicStorefrontSetup, PublicTypeAddon } from '@/lib/booking/public-availability'
import { formatMoney } from '@/lib/format'

/** "₹800" / "₹6,000" / "₹99.50" — whole amounts drop the ".00" the storefront cards don't need. */
function price(amount: string, currency: string): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return formatMoney(amount, currency)
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return formatMoney(amount, currency)
  }
}

type Card = {
  key: string
  href: string
  title: string
  setLabel: string
  typeName: string
  imageUrl: string | null
  capacity: number | null
  description: string | null
  rateText: string
}

function CardLink({ card, showType }: { card: Card; showType: boolean }) {
  return (
    <Link
      href={card.href}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
    >
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-primary/5">
        {card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt={card.title}
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
        <p className="line-clamp-1 text-lg font-bold text-foreground transition group-hover:text-primary">{card.title}</p>
        <p className="mt-1 line-clamp-1 text-sm font-medium text-muted-foreground">
          {card.setLabel}
          {showType ? ` · ${card.typeName}` : ''}
        </p>
        {card.description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{card.description}</p>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          {card.capacity != null ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground/80">
              <Users size={12} /> Up to {card.capacity}
            </span>
          ) : (
            <span />
          )}
          <span className="text-sm font-bold text-primary">{card.rateText}</span>
        </div>
      </div>
    </Link>
  )
}

/**
 * M35 #3: the studio-industry storefront — one card per setup (labelled with
 * its set), grouped by resource type when there is more than one. A set with
 * no active setups still gets a plain card at the type's base rate so it
 * stays bookable. Each type's add-ons show as an informational strip; they
 * are chosen on the booking page once a time (and so stock) is known.
 */
export function StorefrontSetupCards({
  types,
  setups,
  addons,
  currency,
}: {
  types: PublicResourceType[]
  setups: PublicStorefrontSetup[]
  addons: PublicTypeAddon[]
  currency: string
}) {
  const multiType = types.length > 1
  const groups = types
    .map((type) => {
      const cards: Card[] = []
      const setsWithSetups = new Set(setups.filter((s) => s.resourceTypeId === type.id).map((s) => s.resourceId))
      // Keep set order from the catalogue; setups within a set keep fetcher order.
      for (const set of type.resources) {
        if (setsWithSetups.has(set.id)) {
          for (const s of setups.filter((x) => x.resourceId === set.id)) {
            cards.push({
              key: s.setupId,
              href: `/book/${s.resourceId}?setup=${s.setupId}`,
              title: s.setupName,
              setLabel: s.resourceName,
              typeName: s.resourceTypeName,
              imageUrl: s.imageUrl,
              capacity: s.capacity,
              description: s.description,
              rateText: `${price(s.rate, currency)} / ${s.rateUnit === 'day' ? 'day' : 'hr'}`,
            })
          }
        } else {
          cards.push({
            key: `set-${set.id}`,
            href: `/book/${set.id}`,
            title: set.name,
            setLabel: type.name,
            typeName: type.name,
            imageUrl: type.imageUrl,
            capacity: type.capacity,
            description: type.description,
            rateText: `${price(type.hourlyRate, currency)} / hr`,
          })
        }
      }
      return { type, cards, addons: addons.filter((a) => a.resourceTypeId === type.id) }
    })
    .filter((g) => g.cards.length > 0)

  return (
    <div className="space-y-14">
      {groups.map(({ type, cards, addons: typeAddons }) => (
        <section key={type.id}>
          {multiType ? <h2 className="mb-6 text-2xl font-bold tracking-tight">{type.name}</h2> : null}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cards.map((card) => (
              <CardLink key={card.key} card={card} showType={multiType} />
            ))}
          </div>
          {typeAddons.length > 0 ? (
            <p className="mt-5 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">Also available:</span>{' '}
              {typeAddons
                .map((a) => `${a.name} ${price(a.rate, currency)}/${a.rateUnit === 'day' ? 'day' : 'hr'}`)
                .join(' · ')}
            </p>
          ) : null}
        </section>
      ))}
    </div>
  )
}
