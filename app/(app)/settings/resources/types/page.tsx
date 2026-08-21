import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listResourceTypes } from '@/lib/booking/data'
import { ResourceTypesManager } from '@/components/settings/ResourceTypesManager'

export default async function ResourceTypesPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const types = await listResourceTypes(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Resource Types</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Set up the kinds of things customers can book — like “PS5 Station” or “Snooker Table” — with a price per
        hour and a photo.
      </p>
      <ResourceTypesManager
        currency={ctx.tenant.currency}
        types={types.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          hourlyRate: t.hourlyRate,
          bufferMinutes: t.bufferMinutes,
          capacity: t.capacity,
          color: t.color,
          imageUrl: t.imageUrl,
          isActive: t.isActive,
        }))}
      />
    </div>
  )
}
