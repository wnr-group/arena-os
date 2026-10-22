import { Bike, ShoppingBag } from 'lucide-react'

/**
 * Marks a ticket / order card that is NOT for a table (M20 / AROS-182), so the
 * line, the pass and the host can see at a glance it is a takeaway or a
 * delivery — and who it is for / when. Renders nothing for dine-in, so every
 * existing screen is unchanged for table orders.
 */
export function OrderTypeBadge({
  orderType,
  contactName,
  pickupAt,
  className = '',
}: {
  orderType: 'dine_in' | 'takeaway' | 'delivery' | null | undefined
  contactName?: string | null
  /** ISO instant the customer asked for, if any. */
  pickupAt?: string | null
  className?: string
}) {
  if (!orderType || orderType === 'dine_in') return null
  const delivery = orderType === 'delivery'
  const Icon = delivery ? Bike : ShoppingBag
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        delivery ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      } ${className}`}
    >
      <Icon size={10} aria-hidden />
      {delivery ? 'Delivery' : 'Takeaway'}
      {contactName ? <span className="normal-case tracking-normal"> · {contactName}</span> : null}
      {pickupAt ? (
        <span className="normal-case tracking-normal" suppressHydrationWarning>
          {' '}
          · {new Date(pickupAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
        </span>
      ) : null}
    </span>
  )
}
