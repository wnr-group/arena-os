import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * Stock follows what an order's live lines consume (M10 / AROS-98).
 *
 * Both exports reconcile one number per (stock item, order): the NEED — the sum
 * over the order's non-voided lines of `qty × per-portion quantity` — against
 * what the order's earlier 'order' movements already took (the DONE). The
 * difference is written as a movement, source_type 'order', source_id the order.
 *
 *   * deductStockForOrders (billing paths) writes BOTH directions: a positive
 *     remainder is deducted, a negative one restored. A re-run writes nothing.
 *   * restoreStockForOrders (void / qty cut / line removed) writes ONLY
 *     restores. It never deducts, so correcting an order that has not been
 *     billed yet — and so has nothing deducted — stays a no-op.
 *
 * Properties that matter:
 *
 *   * PER-LINE RECIPE SNAPSHOT — the first time a line is deducted, what one
 *     portion consumes (dish recipe + chosen modifier options) is frozen in
 *     order_item_stock_usage. Raising a recipe later does not charge the extra
 *     to portions already sold, and a restore gives back exactly what was taken.
 *     A removed line's snapshot goes with it, so its stock comes back.
 *   * COST SNAPSHOT — each movement records the item's unit cost at that moment
 *     (a restore uses the order's average deducted cost), so food-cost % is
 *     priced at sale time.
 *   * NO RECIPE, NO WORK — a tenant with no recipe, modifier recipe or usage
 *     snapshot returns before taking any lock.
 *   * VOIDED LINES EXCLUDED, COMPED LINES INCLUDED — a voided line never left
 *     the kitchen; a comped plate was cooked and eaten.
 *   * BRANCH-SCOPED — only stock held at the order's own branch is touched.
 *   * ARCHIVED ITEMS SKIPPED.
 *   * NEVER BLOCKS A SALE — stock may go negative; the reorder alert, not a
 *     refusal, is the safeguard.
 *
 * Runs in the CALLER'S transaction, inside a savepoint: if the inventory write
 * ever failed, the bill (or correction) must still commit. The failure is
 * logged loudly rather than swallowed, and the next stock count corrects it.
 */
export function deductStockForOrders(tx: Db, tenantId: string, orderIds: string[]): Promise<{ movements: number }> {
  return reconcile(tx, tenantId, orderIds, 'both')
}

/** Give back stock for lines that were voided, reduced or removed after the
 *  order was deducted. Restore-only: see the module note above. */
export function restoreStockForOrders(tx: Db, tenantId: string, orderIds: string[]): Promise<{ movements: number }> {
  return reconcile(tx, tenantId, orderIds, 'restore')
}

async function reconcile(
  tx: Db,
  tenantId: string,
  orderIds: string[],
  mode: 'both' | 'restore',
): Promise<{ movements: number }> {
  const ids = [...new Set(orderIds)].sort()
  if (ids.length === 0) return { movements: 0 }
  const idList: SQL = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)
  try {
    return await tx.transaction(async (sp) => {
      // Cheap probe first: most tenants have no recipes at all.
      const probe = await sp.execute<{ any: boolean }>(sql`
        select (
          exists (select 1 from public.menu_item_ingredients where tenant_id = ${tenantId})
          or exists (select 1 from public.modifier_option_ingredients where tenant_id = ${tenantId})
          or exists (select 1 from public.order_item_stock_usage where tenant_id = ${tenantId})
        ) as any
      `)
      if (!probe.rows[0]?.any) return { movements: 0 }

      // Serialize concurrent reconciles for the same order (sorted: no deadlocks).
      await sp.execute(sql`
        select id from public.orders
         where tenant_id = ${tenantId} and id in (${idList})
         order by id
           for update
      `)

      if (mode === 'both') {
        // Freeze per-portion usage for lines that have none yet. A line that
        // already has a snapshot keeps it even if the recipe has changed since.
        await sp.execute(sql`
          insert into public.order_item_stock_usage (tenant_id, order_item_id, stock_item_id, per_portion)
          select x.tenant_id, x.order_item_id, x.stock_item_id, sum(x.per)
            from (
              select oi.tenant_id, oi.id as order_item_id, mii.stock_item_id, mii.quantity as per
                from public.orders o
                join public.order_items oi
                  on oi.order_id = o.id and oi.tenant_id = o.tenant_id and oi.void_status <> 'voided'
                join public.menu_item_ingredients mii
                  on mii.menu_item_id = oi.menu_item_id and mii.tenant_id = o.tenant_id
               where o.tenant_id = ${tenantId} and o.id in (${idList})
              union all
              select oi.tenant_id, oi.id, moi.stock_item_id, moi.quantity
                from public.orders o
                join public.order_items oi
                  on oi.order_id = o.id and oi.tenant_id = o.tenant_id and oi.void_status <> 'voided'
                join public.order_item_modifiers oim
                  on oim.order_item_id = oi.id and oim.tenant_id = o.tenant_id
                join public.modifier_option_ingredients moi
                  on moi.option_id = oim.modifier_option_id and moi.tenant_id = o.tenant_id
               where o.tenant_id = ${tenantId} and o.id in (${idList})
            ) x
           where not exists (
             select 1 from public.order_item_stock_usage u where u.order_item_id = x.order_item_id
           )
           group by x.tenant_id, x.order_item_id, x.stock_item_id
          on conflict (order_item_id, stock_item_id) do nothing
        `)
      }

      const res = await sp.execute<{ id: string }>(sql`
        with need as (
          select o.id as order_id, u.stock_item_id, sum(oi.qty * u.per_portion) as amt
            from public.orders o
            join public.order_items oi
              on oi.order_id = o.id and oi.tenant_id = o.tenant_id and oi.void_status <> 'voided'
            join public.order_item_stock_usage u
              on u.order_item_id = oi.id
           where o.tenant_id = ${tenantId} and o.id in (${idList})
           group by o.id, u.stock_item_id
        ),
        done as (
          select m.source_id as order_id, m.stock_item_id,
                 - sum(m.delta) as amt,
                 sum(- m.delta * m.unit_cost) filter (where m.delta < 0 and m.unit_cost is not null) as cost_sum,
                 sum(- m.delta)               filter (where m.delta < 0 and m.unit_cost is not null) as cost_qty
            from public.stock_movements m
           where m.tenant_id = ${tenantId}
             and m.source_type = 'order'
             and m.source_id in (${idList})
           group by m.source_id, m.stock_item_id
        ),
        diff as (
          select coalesce(n.order_id, d.order_id) as order_id,
                 coalesce(n.stock_item_id, d.stock_item_id) as stock_item_id,
                 coalesce(n.amt, 0) - coalesce(d.amt, 0) as owed,
                 d.cost_sum, d.cost_qty
            from need n
            full join done d
              on d.order_id = n.order_id and d.stock_item_id = n.stock_item_id
        )
        insert into public.stock_movements (tenant_id, stock_item_id, delta, reason, source_type, source_id, unit_cost)
        select ${tenantId}::uuid,
               f.stock_item_id,
               - f.owed,
               case when f.owed > 0 then 'Sold' else 'Restored (order changed)' end,
               'order',
               f.order_id,
               case when f.owed > 0 then si.unit_cost
                    else coalesce(f.cost_sum / nullif(f.cost_qty, 0), si.unit_cost) end
          from diff f
          join public.orders o on o.id = f.order_id and o.tenant_id = ${tenantId}
          join public.stock_items si
            on si.id = f.stock_item_id
           and si.tenant_id = ${tenantId}
           and si.branch_id = o.branch_id
           and si.active
         where ${mode === 'both' ? sql`f.owed <> 0` : sql`f.owed < 0`}
        returning id
      `)
      return { movements: res.rows.length }
    })
  } catch (e) {
    console.error('[inventory] stock reconcile failed; continuing:', e instanceof Error ? e.message : e)
    return { movements: 0 }
  }
}
