'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { orders, orderItems, menuItems, taxRates, bookings, happyHours } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { todayInZone } from '@/lib/booking/time'
import { applyHappyHour } from '@/lib/happy-hours/apply'

type CreateResult = { error?: string; orderId?: string; orderNumber?: string }

function fail(e: unknown): CreateResult {
  if (e instanceof AuthError) return { error: e.message }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const createInput = z.object({
  branchId: z.string().uuid(),
  bookingId: z.string().uuid().optional(),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        qty: z.coerce.number().int().min(1),
        specialInstructions: z.string().trim().optional(),
      }),
    )
    .min(1, 'Add at least one item'),
})

export async function createOrder(input: z.input<typeof createInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    const v = createInput.parse(input)

    const result = await withUser(ctx.user.id, async (tx) => {
      // Snapshot each item's current name/price/tax so the order stays accurate
      // even if the menu changes later.
      const ids = [...new Set(v.items.map((i) => i.menuItemId))]
      const rows = await tx
        .select({
          id: menuItems.id,
          name: menuItems.name,
          price: menuItems.price,
          taxPercent: taxRates.percent,
        })
        .from(menuItems)
        .leftJoin(taxRates, eq(taxRates.id, menuItems.taxRateId))
        .where(and(eq(menuItems.tenantId, ctx.tenant.id), inArray(menuItems.id, ids)))

      const byId = new Map(rows.map((r) => [r.id, r]))
      if (byId.size !== ids.length) throw new Error('One or more menu items were not found.')

      // Rules to weigh against every line. Read once per order, then matched
      // in memory — the "is it happy hour right now" decision is made here,
      // on the server, never trusted from the browser.
      const rules = await tx
        .select({
          id: happyHours.id,
          name: happyHours.name,
          daysOfWeek: happyHours.daysOfWeek,
          startTime: happyHours.startTime,
          endTime: happyHours.endTime,
          discountType: happyHours.discountType,
          discountValue: happyHours.discountValue,
          isActive: happyHours.isActive,
        })
        .from(happyHours)
        .where(and(eq(happyHours.tenantId, ctx.tenant.id), eq(happyHours.isActive, true)))
      const now = new Date()

      if (v.bookingId) {
        const [booking] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(and(eq(bookings.id, v.bookingId), eq(bookings.tenantId, ctx.tenant.id)))
          .limit(1)
        if (!booking) throw new Error('Booking not found.')
      }

      // Order number: OR-YYYYMMDD-NNN, sequential per tenant per creation day.
      const compact = todayInZone(ctx.tenant.timezone).replace(/-/g, '')
      const prefix = `OR-${compact}`
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(orders)
        .where(and(eq(orders.tenantId, ctx.tenant.id), like(orders.orderNumber, `${prefix}-%`)))
      const orderNumber = `${prefix}-${String(Number(n) + 1).padStart(3, '0')}`

      const [order] = await tx
        .insert(orders)
        .values({
          tenantId: ctx.tenant.id,
          branchId: v.branchId,
          bookingId: v.bookingId || null,
          orderNumber,
          status: 'open',
          createdBy: ctx.membershipId,
        })
        .returning({ id: orders.id })

      await tx.insert(orderItems).values(
        v.items.map((i) => {
          const m = byId.get(i.menuItemId)!
          const basePrice = Number(m.price)
          // Every item is in scope: a live rule discounts whatever is ordered
          // inside its time window, with no per-item opt-in required.
          const applied = applyHappyHour(basePrice, rules, now, ctx.tenant.timezone)
          const unitPrice = applied ? applied.unitPrice : basePrice
          return {
            tenantId: ctx.tenant.id,
            orderId: order.id,
            menuItemId: i.menuItemId,
            itemName: m.name,
            unitPrice: unitPrice.toFixed(2),
            taxRate: Number(m.taxPercent ?? 0).toFixed(2),
            qty: i.qty,
            lineTotal: (unitPrice * i.qty).toFixed(2),
            specialInstructions: i.specialInstructions || null,
            // Snapshot so an edited/deleted happy-hour rule never changes what
            // this line already charged.
            happyHourId: applied?.rule.id ?? null,
            happyHourName: applied?.rule.name ?? null,
            originalUnitPrice: applied ? basePrice.toFixed(2) : null,
            happyHourDiscountType: applied?.rule.discountType ?? null,
            happyHourDiscountValue: applied ? Number(applied.rule.discountValue).toFixed(2) : null,
          }
        }),
      )

      return { id: order.id, orderNumber }
    })

    revalidatePath('/bookings')
    return { orderId: result.id, orderNumber: result.orderNumber }
  } catch (e) {
    return fail(e)
  }
}
