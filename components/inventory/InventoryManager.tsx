'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createStockItem, recordStockMovement, saveRecipe, updateStockItem } from '@/lib/actions/inventory'
import { MANUAL_MOVEMENT_TYPES, STOCK_UNITS, isLowStock, type ManualMovementType } from '@/lib/inventory/rules'

const field = 'rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50'

export type StockItemView = { id: string; name: string; unit: string; quantity: number; reorderLevel: number; active: boolean }
export type RecipeView = { menuItemId: string; stockItemId: string; quantity: number }
export type MenuItemView = { id: string; name: string }
export type MovementView = { id: string; stockItemId: string; delta: number; reason: string | null; sourceType: string; at: string }

const TYPE_LABEL: Record<ManualMovementType, string> = {
  opening: 'Opening stock',
  purchase: 'Purchase / delivery',
  adjustment: 'Count correction (+/−)',
  wastage: 'Wastage',
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ''))

function StockTab({ branchId, items, movements, timeZone }: { branchId: string; items: StockItemView[]; movements: MovementView[]; timeZone: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('kg')
  const [reorder, setReorder] = useState('0')
  const [opening, setOpening] = useState('0')
  const [moving, setMoving] = useState<{ id: string; type: ManualMovementType; amount: string; reason: string } | null>(null)
  const nameOf = new Map(items.map((i) => [i.id, i]))

  function act(fn: () => Promise<{ error?: string }>, done?: string) {
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        if (done) toast.success(done)
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-base font-semibold">Add a stock item</h2>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            Name
            <input className={`${field} mt-1 block w-48`} value={name} maxLength={80} placeholder="e.g. Paneer" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-xs text-muted-foreground">
            Unit
            <input className={`${field} mt-1 block w-24`} list="stock-units" value={unit} maxLength={20} onChange={(e) => setUnit(e.target.value)} />
            <datalist id="stock-units">
              {STOCK_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </label>
          <label className="text-xs text-muted-foreground">
            Opening stock
            <input className={`${field} mt-1 block w-28`} type="number" min={0} step="any" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </label>
          <label className="text-xs text-muted-foreground">
            Reorder at
            <input className={`${field} mt-1 block w-28`} type="number" min={0} step="any" value={reorder} onChange={(e) => setReorder(e.target.value)} />
          </label>
          <button
            disabled={pending || !name.trim()}
            className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() =>
              act(async () => {
                const r = await createStockItem({ branchId, name, unit, reorderLevel: Number(reorder) || 0, openingQuantity: Number(opening) || 0 })
                if (!r.error) {
                  setName('')
                  setOpening('0')
                }
                return r
              }, 'Stock item added.')
            }
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">Stock on hand</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">On hand</th>
                <th className="px-3 py-2 text-right">Reorder at</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                    No stock items yet.
                  </td>
                </tr>
              )}
              {items.map((i) => {
                const low = i.active && isLowStock(i.quantity, i.reorderLevel)
                return (
                  <tr key={i.id} className={`border-t border-border ${i.active ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2 font-medium">
                      {i.name}
                      {!i.active && <span className="ml-2 text-xs font-normal text-muted-foreground">archived</span>}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${i.quantity < 0 ? 'text-destructive' : ''}`}>
                      {low && <AlertTriangle size={13} className="mr-1.5 inline text-amber-600" aria-label="Low stock" />}
                      {fmt(i.quantity)} {i.unit}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{i.reorderLevel > 0 ? `${fmt(i.reorderLevel)} ${i.unit}` : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {i.active && (
                        <button className={`${btn} border border-border hover:bg-muted`} onClick={() => setMoving({ id: i.id, type: 'purchase', amount: '', reason: '' })}>
                          Update stock
                        </button>
                      )}{' '}
                      <button
                        disabled={pending}
                        className={`${btn} text-muted-foreground hover:bg-muted`}
                        onClick={() => act(() => updateStockItem({ id: i.id, name: i.name, unit: i.unit, reorderLevel: i.reorderLevel, active: !i.active }), i.active ? 'Archived.' : 'Restored.')}
                      >
                        {i.active ? 'Archive' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          On hand is the sum of every movement below. A negative figure means dishes sold before the stock was counted in — correct it with a count.
        </p>
      </section>

      {moving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMoving(null)}>
          <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Update {nameOf.get(moving.id)?.name}</h2>
            <div className="mt-4 space-y-3">
              <select className={`${field} w-full`} value={moving.type} onChange={(e) => setMoving({ ...moving, type: e.target.value as ManualMovementType })}>
                {MANUAL_MOVEMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <input
                className={`${field} w-full`}
                type="number"
                step="any"
                autoFocus
                placeholder={`Quantity (${nameOf.get(moving.id)?.unit})`}
                value={moving.amount}
                onChange={(e) => setMoving({ ...moving, amount: e.target.value })}
              />
              <input className={`${field} w-full`} placeholder="Note (optional)" maxLength={200} value={moving.reason} onChange={(e) => setMoving({ ...moving, reason: e.target.value })} />
              <button
                disabled={pending || !moving.amount}
                className={`${btn} w-full bg-primary text-primary-foreground hover:opacity-90`}
                onClick={() =>
                  act(async () => {
                    const r = await recordStockMovement({ stockItemId: moving.id, type: moving.type, amount: Number(moving.amount), reason: moving.reason })
                    if (!r.error) setMoving(null)
                    return r
                  }, 'Stock updated.')
                }
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <section>
        <h2 className="text-base font-semibold">Recent movements</h2>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border text-sm">
          {movements.length === 0 && <li className="px-3 py-6 text-center text-muted-foreground">Nothing recorded yet.</li>}
          {movements.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-x-4 px-3 py-2">
              <span className="w-32 text-xs text-muted-foreground">
                {new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(m.at))}
              </span>
              <span className="flex-1 truncate">{nameOf.get(m.stockItemId)?.name ?? 'Item'}</span>
              <span className="text-xs text-muted-foreground">{m.sourceType === 'order' ? 'Sold' : m.reason || m.sourceType}</span>
              <span className={`w-24 text-right tabular-nums font-medium ${m.delta < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                {m.delta > 0 ? '+' : ''}
                {fmt(m.delta)} {nameOf.get(m.stockItemId)?.unit}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function RecipesTab({ items, menu, recipes }: { items: StockItemView[]; menu: MenuItemView[]; recipes: RecipeView[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [menuId, setMenuId] = useState(menu[0]?.id ?? '')
  const active = items.filter((i) => i.active)
  const saved = recipes.filter((r) => r.menuItemId === menuId).map((r) => ({ stockItemId: r.stockItemId, quantity: String(r.quantity) }))
  const [draft, setDraft] = useState<{ menuId: string; rows: { stockItemId: string; quantity: string }[] } | null>(null)
  const rows = draft && draft.menuId === menuId ? draft.rows : saved
  const dirty = draft !== null && draft.menuId === menuId
  const linked = new Set(recipes.map((r) => r.menuItemId))
  const unit = (id: string) => items.find((i) => i.id === id)?.unit ?? ''

  const setRows = (next: { stockItemId: string; quantity: string }[]) => setDraft({ menuId, rows: next })

  if (menu.length === 0) return <p className="text-sm text-muted-foreground">Add menu items first (Menu → Items), then link them to stock here.</p>

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <ul className="max-h-[28rem] overflow-y-auto rounded-lg border border-border text-sm">
        {menu.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => {
                setMenuId(m.id)
                setDraft(null)
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted ${m.id === menuId ? 'bg-muted font-medium' : ''}`}
            >
              <span className="truncate">{m.name}</span>
              {linked.has(m.id) && <span className="ml-2 rounded-full bg-primary/10 px-2 text-xs text-primary">linked</span>}
            </button>
          </li>
        ))}
      </ul>

      <div>
        <h2 className="text-base font-semibold">{menu.find((m) => m.id === menuId)?.name}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">What one portion uses. Items with no ingredients are never deducted.</p>
        <div className="mt-3 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className={`${field} flex-1`}
                value={r.stockItemId}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, stockItemId: e.target.value } : x)))}
              >
                <option value="">Choose stock item…</option>
                {active.map((s) => (
                  <option key={s.id} value={s.id} disabled={rows.some((x, j) => j !== i && x.stockItemId === s.id)}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input
                className={`${field} w-28`}
                type="number"
                min={0}
                step="any"
                placeholder="Qty"
                value={r.quantity}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              />
              <span className="w-10 text-xs text-muted-foreground">{unit(r.stockItemId)}</span>
              <button aria-label="Remove ingredient" className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {rows.length === 0 && <p className="text-sm text-muted-foreground">No ingredients — this item is not linked to stock.</p>}
        </div>
        <div className="mt-3 flex gap-2">
          <button className={`${btn} inline-flex items-center gap-1.5 border border-border hover:bg-muted`} disabled={active.length === 0} onClick={() => setRows([...rows, { stockItemId: '', quantity: '' }])}>
            <Plus size={14} /> Ingredient
          </button>
          <button
            disabled={pending || !dirty}
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() =>
              start(async () => {
                const filled = rows.filter((r) => r.stockItemId || r.quantity)
                const r = await saveRecipe({ menuItemId: menuId, ingredients: filled.map((x) => ({ stockItemId: x.stockItemId, quantity: Number(x.quantity) })) })
                if (r.error) toast.error(r.error)
                else {
                  toast.success('Recipe saved.')
                  setDraft(null)
                  router.refresh()
                }
              })
            }
          >
            Save recipe
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Applies to orders billed from now on; earlier sales are never re-deducted.</p>
      </div>
    </div>
  )
}

export function InventoryManager(props: {
  branchId: string
  timeZone: string
  items: StockItemView[]
  menu: MenuItemView[]
  recipes: RecipeView[]
  movements: MovementView[]
}) {
  const [tab, setTab] = useState<'stock' | 'recipes'>('stock')
  const low = props.items.filter((i) => i.active && isLowStock(i.quantity, i.reorderLevel)).length
  return (
    <div className="mt-6">
      <div className="flex gap-1 border-b border-border">
        {(['stock', 'recipes'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t === 'stock' ? `Stock${low > 0 ? ` (${low} low)` : ''}` : 'Recipes'}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === 'stock' ? (
          <StockTab branchId={props.branchId} items={props.items} movements={props.movements} timeZone={props.timeZone} />
        ) : (
          <RecipesTab items={props.items} menu={props.menu} recipes={props.recipes} />
        )}
      </div>
    </div>
  )
}
