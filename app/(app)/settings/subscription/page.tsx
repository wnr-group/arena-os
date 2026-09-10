import { permanentRedirect } from 'next/navigation'

/**
 * The M16 #3 subscription page moved to /settings/billing in M16 #5, where it
 * became the full owner billing portal (usage, plan comparison, payment method,
 * confirmation flow).
 *
 * This redirect stays because the old path was linked from the sidebar and from
 * every invoice page shipped before the move, and a bookmarked billing link
 * going 404 is a bad way to learn about a rename. `permanentRedirect` (308)
 * rather than a temporary one: the route is not coming back.
 *
 * The alternative — leaving the old page alive — would mean two surfaces that
 * both change a subscription, which is precisely the duplication this ticket
 * forbids.
 */
export default function SubscriptionSettingsRedirect(): never {
  permanentRedirect('/settings/billing')
}
