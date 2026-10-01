import Link from 'next/link'
import { ArrowRight, Layers } from 'lucide-react'
import type { PublicTenant } from '@/lib/tenant/public'
import type { PublicResourceTypeDetail, PublicTypeUnit } from '@/lib/booking/public-availability'
import { formatMoney } from '@/lib/format'

/**
 * Studio types (recording/podcast/dance studio, VR centre): each unit is a
 * distinct physical set with its own named setups ("Kitchen", "Royal", …), so
 * the customer chooses the set — and sees what setups it offers and at what
 * price — before the booking page (/book/[unitId]), where the setup itself is
 * picked and priced.
 */
export function ResourceUnitPicker({
  tenant,
  resourceType,
  units,
}: {
  tenant: PublicTenant
  resourceType: PublicResourceTypeDetail
  units: PublicTypeUnit[]
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">{resourceType.name}</h1>
      {resourceType.description && <p className="mt-2 text-sm text-muted-foreground">{resourceType.description}</p>}
      <p className="mt-6 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Layers size={16} className="text-primary" /> Choose a set
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Pick the set you want to book — each one lists the setups you can choose from next.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {units.map((u) => (
          <Link
            key={u.id}
            href={`/book/${u.id}`}
            className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-bold text-foreground group-hover:text-primary">{u.name}</span>
              <ArrowRight size={16} className="text-muted-foreground transition group-hover:text-primary" />
            </div>
            {u.setups.length > 0 ? (
              <ul className="space-y-1.5">
                {u.setups.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium text-foreground">{s.name}</span>
                    <span className="tabular-nums text-primary">
                      {formatMoney(Number(s.rate), tenant.currency)} / {s.rateUnit === 'day' ? 'day' : 'hr'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Standard rate only</p>
            )}
            <span className="text-xs text-muted-foreground">
              Base rate {formatMoney(Number(resourceType.hourlyRate), tenant.currency)} / hr
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
