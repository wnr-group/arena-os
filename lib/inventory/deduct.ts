import 'server-only'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * Deduct stock for food orders that have just been billed (M10 / AROS-98).
 *
 * One movement per (stock item, order): the SUM over the order's lines (dish recipe AND
 * the ingredients of any chosen modifier options) of
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
        with lines as (
          -- the dish's own recipe, per portion sold
          select o.tenant_id, o.id as order_id, o.branch_id, mii.stock_item_id,
                 oi.qty * mii.quantity as amt
            from public.orders o
            join public.order_items oi
              on oi.order_id = o.id
             and oi.tenant_id = o.tenant_id
             and oi.void_status <> 'voided'
            join public.menu_item_ingredients mii
              on mii.menu_item_id = oi.menu_item_id
             and mii.tenant_id = o.tenant_id
           where o.tenant_id = ${tenantId}
             and o.id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `)})
          union all
          -- plus whatever the chosen modifier options add ("extra cheese"), per portion
          select o.tenant_id, o.id, o.branch_id, moi.stock_item_id,
                 oi.qty * moi.quantity
            from public.orders o
            join public.order_items oi
              on oi.order_id = o.id
             and oi.tenant_id = o.tenant_id
             and oi.void_status <> 'voided'
            join public.order_item_modifiers oim
              on oim.order_item_id = oi.id
             and oim.tenant_id = o.tenant_id
            join public.modifier_option_ingredients moi
              on moi.option_id = oim.modifier_option_id
             and moi.tenant_id = o.tenant_id
           where o.tenant_id = ${tenantId}
             and o.id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`), sql`, `)})
        )
        insert into public.stock_movements (tenant_id, stock_item_id, delta, reason, source_type, source_id)
        select l.tenant_id,
               l.stock_item_id,
               - sum(l.amt),
               'Sold',
               'order',
               l.order_id
          from lines l
          join public.stock_items si
            on si.id = l.stock_item_id
           and si.tenant_id = l.tenant_id
           and si.branch_id = l.branch_id
           and si.active
         group by l.tenant_id, l.stock_item_id, l.order_id
        having sum(l.amt) > 0
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
