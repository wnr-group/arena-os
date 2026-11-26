'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Receipt } from 'lucide-react'
import { CounterOrderDialog } from '@/components/orders/CounterOrderDialog'
import type { CategoryOption, MenuItemOption } from '@/components/orders/TakeOrderDialog'
import type { HappyHourRule } from '@/lib/happy-hours/apply'

/**
 * "Counter order" — sits beside New booking on the Bookings page. Rendered only
 * for non-restaurant venues, on a plan with the module, for roles that can manage
 * walk-ins (counterOrdersAvailable); the server actions re-check all three.
 */
export function CounterOrderButton(props: {
  branchId: string
  currency: string
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
  timeZone: string
  canToggle86: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={props.menuItems.length === 0}
        title={props.menuItems.length === 0 ? 'Add menu items first' : undefined}
        className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-accent px-3 py-2 text-base font-medium text-accent-foreground transition hover:bg-accent/70 disabled:opacity-50"
      >
        <Receipt size={16} /> Counter order
      </button>
      {open && (
        <CounterOrderDialog
          {...props}
          onClose={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      )}
    </>
  )
}
