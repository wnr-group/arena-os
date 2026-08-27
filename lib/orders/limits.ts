/**
 * Shared with the server: lib/actions/public-orders.ts's `items[].qty` zod
 * schema enforces the same number. Keeping both reads of "20" pointed at
 * this one constant is what stops the client cap and the server's actual
 * limit from silently drifting apart — a customer's cart must never be able
 * to build a line the server will then reject.
 */
export const MAX_ORDER_ITEM_QTY = 20
