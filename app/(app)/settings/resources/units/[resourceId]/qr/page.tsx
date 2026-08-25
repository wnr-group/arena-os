import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { resources } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { publicTenantUrl } from '@/lib/tenant/subdomain'
import { generateQrSvg } from '@/lib/utils/qr'
import { PrintButton } from '@/components/invoices/PrintButton'

/**
 * View/print a station's ordering QR — the staff side of the QR-at-station
 * entry point (M14 #2). The code encodes the same public URL a customer's
 * scan lands on: app/(public)/order/[stationToken].
 */
export default async function ResourceQrPage({ params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [resource] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: resources.id, name: resources.name, qrToken: resources.qrToken })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.tenantId, ctx.tenant.id)))
      .limit(1),
  )
  if (!resource) notFound()

  const orderUrl = publicTenantUrl(ctx.tenant.slug, `/order/${resource.qrToken}`)
  const qrSvg = await generateQrSvg(orderUrl)

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/settings/resources/units"
        className="no-print inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> Back to resources
      </Link>

      <div className="print-sheet mt-6 flex flex-col items-center rounded-2xl border border-border bg-card p-10 text-center shadow-sm">
        <h1 className="text-xl font-semibold">{resource.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Scan to order from this station</p>

        <div className="mt-6 size-56 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />

        <p className="mt-4 break-all text-xs text-muted-foreground">{orderUrl}</p>
      </div>

      <div className="no-print mt-6 flex justify-center">
        <PrintButton />
      </div>
    </div>
  )
}
