-- Stock deduction becomes incremental per order.
--
-- 0153 allowed one 'order' movement per (stock item, order), so lines added and
-- billed after the first deduction (split bill, re-bill after a void) were never
-- deducted. deductStockForOrders now writes the DIFFERENCE between what the
-- order's live lines need and what its earlier movements already took, under a
-- row lock on the order — still exactly-once in effect, but a later top-up is
-- recorded as its own movement. The one-per-order index must therefore go.
drop index if exists public.uq_stock_movements_order_once;

create index if not exists idx_stock_movements_order_source
  on public.stock_movements(tenant_id, source_id)
  where source_type = 'order';
