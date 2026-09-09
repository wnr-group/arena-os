import { permanentRedirect } from 'next/navigation'

/**
 * Moved to /settings/billing/invoices/[id] in M16 #5, along with the rest of
 * the billing surface. The id is carried across so a link to a specific invoice
 * — the kind of URL that ends up in an accountant's email — still resolves.
 */
export default async function InvoiceRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<never> {
  const { id } = await params
  permanentRedirect(`/settings/billing/invoices/${encodeURIComponent(id)}`)
}
