import 'server-only'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * Deduct stock for food orders that have just been billed (M10 / AROS-98).
 *
 * One movement per (stock item, order): the SUM over the order's lines of
 * `sold qty × recipe quantity per portion`, source_type 'order', source_id the
 * order. Properties that matter:
 *
 *   * NO RECIPE, NO MOVEMENT — a menu item without menu_item_ingredients rows
 *     joins to nothing, so unlinked items (and tenants who never use
 *     inventory) cost one empty query and change nothing.
 *   * EXACTLY ONCE — uq_stock_movements_order_once (0153) is unique on
 *     (stock item, order), and the insert is ON CONFLICT DO NOTHING, so a
 *     re-run (invoice voided then re-billed, a webhook retry, a split bill)
 *     can never deduct the same sale twice. Returns only what it newly wrote.
 *   * VOIDED LINES EXCLUDED, COMPED LINES INCLUDED — a voided line never left
 *     the kitchen; a comped plate was cooked and eaten.
 *   * BRANCH-SCOPED — only stock held at the order's own branch is touched.
 *   * ARCHIVED ITEMS SKIPPED.
 *   * NEVER BLOCKS A SALE — stock may go negative (sold before it was counted
 *     in); the reorder alert, not a refusal, is the safeguard.
 *
 * Runs in the CALLER'S transaction, inside a savepoint: if the inventory write
 * ever failed, the bill must still commit. The failure is logged loudly rather
 * than swallowed, and the next stock count corrects the drift.
 */
export async function deductStockForOrders(
  tx: Db,
  tenantId: string,
  orderIds: string[],
): Promise<{ movements: number }> {
  if (orderIds.length === 0) return { movements: 0 }
  try {
    return await tx.transaction(async (sp) => {
      const res = await sp.execute<{ id: string }>(sql`
        insert into public.stock_movements (tenant_id, stock_item_id, delta, reason, source_type, source_id)
        select o.tenant_id,
               mii.stock_item_id,
               - sum(oi.qty * mii.quantity),
               'Sold',
               'order',
               o.id
          from public.orders o
          join public.order_items oi
            on oi.order_id = o.id
           and oi.tenant_id = o.tenant_id
           and oi.void_status <> 'voided'
          join public.menu_item_ingredients mii
            on mii.menu_item_id = oi.menu_item_id
           and mii.tenant_id = o.tenant_id
          join public.stock_items si
            on si.id = mii.stock_item_id
           and si.tenant_id = o.tenant_id
           and si.branch_id = o.branch_id
           and si.active
         where o.tenant_id = ${tenantId}
           and o.id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `)})
         group by o.tenant_id, mii.stock_item_id, o.id
        having sum(oi.qty * mii.quantity) > 0
        on conflict (stock_item_id, source_id) where source_type = 'order' do nothing
        returning id
      `)
      return { movements: res.rows.length }
    })
  } catch (e) {
    console.error('[inventory] stock deduction failed; billing continues:', e instanceof Error ? e.message : e)
    return { movements: 0 }
  }
}
