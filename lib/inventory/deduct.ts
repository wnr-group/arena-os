import 'server-only'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * Deduct stock for food orders that have just been billed (M10 / AROS-98).
 *
 * Per (stock item, order): the SUM over the order's lines (dish recipe AND
 * the ingredients of any chosen modifier options) of
 * `sold qty × recipe quantity per portion`, minus whatever earlier movements for
 * that order already took; a positive remainder is written as a movement,
 * source_type 'order', source_id the order. Properties that matter:
 *
 *   * NO RECIPE, NO MOVEMENT — a menu item without menu_item_ingredients rows
 *     joins to nothing, so unlinked items (and tenants who never use
 *     inventory) cost one empty query and change nothing.
 *   * EXACTLY ONCE, TOP-UPS INCLUDED — only the not-yet-deducted difference is
 *     written, under a row lock on the order, so a re-run (invoice voided then
 *     re-billed, a webhook retry) writes nothing, while lines added and billed
 *     later (split bill, re-bill) are deducted as their own movement. Nothing is
 *     ever restocked automatically. Returns only what it newly wrote.
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
  const ids = [...new Set(orderIds)].sort()
  if (ids.length === 0) return { movements: 0 }
  try {
    return await tx.transaction(async (sp) => {
      // Serialize concurrent deductions for the same order (sorted: no deadlocks).
      await sp.execute(sql`
        select id from public.orders
         where tenant_id = ${tenantId}
           and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
         order by id
           for update
      `)
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
             and o.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
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
             and o.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        )
        , need as (
          select l.tenant_id, l.stock_item_id, l.order_id, sum(l.amt) as amt
            from lines l
            join public.stock_items si
              on si.id = l.stock_item_id
             and si.tenant_id = l.tenant_id
             and si.branch_id = l.branch_id
             and si.active
           group by l.tenant_id, l.stock_item_id, l.order_id
        ),
        done as (
          select m.stock_item_id, m.source_id, - sum(m.delta) as amt
            from public.stock_movements m
           where m.tenant_id = ${tenantId}
             and m.source_type = 'order'
             and m.source_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           group by m.stock_item_id, m.source_id
        )
        insert into public.stock_movements (tenant_id, stock_item_id, delta, reason, source_type, source_id)
        select n.tenant_id,
               n.stock_item_id,
               - (n.amt - coalesce(d.amt, 0)),
               'Sold',
               'order',
               n.order_id
          from need n
          left join done d
            on d.stock_item_id = n.stock_item_id
           and d.source_id = n.order_id
         where n.amt - coalesce(d.amt, 0) > 0
        returning id
      `)
      return { movements: res.rows.length }
    })
  } catch (e) {
    console.error('[inventory] stock deduction failed; billing continues:', e instanceof Error ? e.message : e)
    return { movements: 0 }
  }
}
