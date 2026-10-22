'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Bike, Clock, Loader2, MapPin, Phone, Plus, ShoppingBag, X } from 'lucide-react'
import { toast } from 'sonner'
import { cancelTypedOrder, collectOrderPayment, createTypedOrder, handoverOrder } from '@/lib/actions/typed-orders'
import { TakeOrderDialog, type CategoryOption, type MenuItemOption } from '@/components/orders/TakeOrderDialog'
import { OrderTypeBadge } from '@/components/orders/OrderTypeBadge'
import { isValidPhone } from '@/lib/customers/phone'
import { formatMoney } from '@/lib/format'
import type { HappyHourRule } from '@/lib/happy-hours/apply'
import { HANDOVER_LABEL, STAGE_LABEL, nextHandovers, type HandoverStatus, type OrderStage, type TypedOrderType } from '@/lib/orders/typed-rules'

const POLL_MS = 5000
const input = 'w-full rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'

export type TypedOrderCard = {
  orderId: string
  orderNumber: string
  orderType: TypedOrderType
  channel: 'staff' | 'online'
  stage: OrderStage
  createdAt: string
  pickupAt: string | null
  contactName: string | null
  contactPhone: string | null
  deliveryAddress: string | null
  deliveryFee: number
  driverName: string | null
  driverPhone: string | null
  notes: string | null
  paid: boolean
  invoiceId: string | null
  items: { name: string; qty: number; notes: string | null; modifiers: string[] }[]
}

type Details = {
  orderType: TypedOrderType
  contactName: string
  contactPhone: string
  pickupAt?: string
  deliveryAddress: string
  deliveryFee: number
  notes: string
}

const STAGE_BADGE: Record<OrderStage, string> = {
  received: 'bg-blue-500/10 text-blue-600',
  preparing: 'bg-amber-500/10 text-amber-600',
  ready: 'bg-emerald-500/10 text-emerald-600',
  out_for_delivery: 'bg-violet-500/10 text-violet-600',
  collected: 'bg-muted text-muted-foreground',
  delivered: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

function DetailsDialog({
  takeawayEnabled,
  deliveryEnabled,
  defaultFee,
  feeTaxRate,
  currency,
  onClose,
  onContinue,
}: {
  takeawayEnabled: boolean
  deliveryEnabled: boolean
  defaultFee: number
  feeTaxRate: number
  currency: string
  onClose: () => void
  onContinue: (d: Details) => void
}) {
  const [orderType, setOrderType] = useState<TypedOrderType>(takeawayEnabled ? 'takeaway' : 'delivery')
  const [contactName, setName] = useState('')
  const [contactPhone, setPhone] = useState('')
  const [time, setTime] = useState('')
  const [deliveryAddress, setAddress] = useState('')
  const [fee, setFee] = useState(String(defaultFee))
  const [notes, setNotes] = useState('')

  const delivery = orderType === 'delivery'
  const phoneBad = contactPhone.trim() && !isValidPhone(contactPhone)
  const ready = contactName.trim() && !phoneBad && (!delivery || (contactPhone.trim() && deliveryAddress.trim()))

  function go() {
    let pickupAt: string | undefined
    if (time) {
      const [h, m] = time.split(':').map(Number)
      const d = new Date()
      d.setHours(h, m, 0, 0)
      pickupAt = d.toISOString()
    }
    onContinue({ orderType, contactName: contactName.trim(), contactPhone: contactPhone.trim(), pickupAt, deliveryAddress: deliveryAddress.trim(), deliveryFee: Number(fee) || 0, notes: notes.trim() })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">New order</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          {takeawayEnabled && deliveryEnabled && (
            <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
              {(['takeaway', 'delivery'] as const).map((t) => (
                <button key={t} onClick={() => setOrderType(t)} className={`rounded px-4 py-1.5 font-medium ${orderType === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {t === 'takeaway' ? 'Takeaway' : 'Delivery'}
                </button>
              ))}
            </div>
          )}
          <div>
            <label className={label}>{delivery ? 'Customer name' : 'Name for the order'} *</label>
            <input className={input} value={contactName} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={label}>Phone{delivery ? ' *' : ''}</label>
            <input className={input} value={contactPhone} inputMode="tel" onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))} />
            {phoneBad && <p className="mt-1 text-sm text-destructive">Enter a valid 10-digit phone number.</p>}
          </div>
          {delivery ? (
            <>
              <div>
                <label className={label}>Delivery address *</label>
                <textarea className={input} rows={3} maxLength={300} value={deliveryAddress} onChange={(e) => setAddress(e.target.value)} />
              </div>
              <div>
                <label className={label}>
                  Delivery fee ({currency}){feeTaxRate > 0 ? ` — GST ${feeTaxRate}% added` : ''}
                </label>
                <input className={input} type="number" min={0} step="any" value={fee} onChange={(e) => setFee(e.target.value)} />
              </div>
            </>
          ) : (
            <div>
              <label className={label}>Pickup time (optional)</label>
              <input className={input} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          <div>
            <label className={label}>Notes</label>
            <input className={input} value={notes} maxLength={300} placeholder="Gate code, allergies…" onChange={(e) => setNotes(e.target.value)} />
          </div>
          <button onClick={go} disabled={!ready} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            Choose items
          </button>
        </div>
      </div>
    </div>
  )
}

function DriverDialog({ onClose, onSubmit, pending }: { onClose: () => void; onSubmit: (name: string, phone: string) => void; pending: boolean }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Who is delivering?</h2>
        <div className="mt-3 space-y-3">
          <input className={input} placeholder="Driver name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <input className={input} placeholder="Driver phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))} />
          <button disabled={!name.trim() || pending} onClick={() => onSubmit(name.trim(), phone.trim())} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {pending && <Loader2 size={15} className="animate-spin" />} Send out
          </button>
        </div>
      </div>
    </div>
  )
}

export function TypedOrdersBoard({
  branchId,
  currency,
  timeZone,
  takeawayEnabled,
  deliveryEnabled,
  defaultFee,
  feeTaxRate,
  orders,
  categories,
  menuItems,
  happyHours,
}: {
  branchId: string
  currency: string
  timeZone: string
  takeawayEnabled: boolean
  deliveryEnabled: boolean
  defaultFee: number
  feeTaxRate: number
  orders: TypedOrderCard[]
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [now, setNow] = useState(() => Date.now())
  const [newOpen, setNewOpen] = useState(false)
  const [details, setDetails] = useState<Details | null>(null)
  const [picking, setPicking] = useState(false)
  const [driverFor, setDriverFor] = useState<string | null>(null)
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'upi'>('cash')

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
      router.refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [router])

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
  const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  const mins = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Takeaway &amp; delivery</h1>
          <p className="mt-1 text-sm text-muted-foreground">{orders.length === 0 ? 'No live orders' : `${orders.length} live`} — they go straight to the kitchen; no table is opened.</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="rounded-md border bg-background px-2 py-2 text-sm" value={payMethod} onChange={(e) => setPayMethod(e.target.value as 'cash' | 'card' | 'upi')} aria-label="Payment method">
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="upi">UPI</option>
          </select>
          <button
            onClick={() => {
              setDetails(null)
              setPicking(false)
              setNewOpen(true)
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus size={15} /> New order
          </button>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">Nothing to hand over right now.</div>
      ) : (
        <ul className="mt-5 grid gap-3 md:grid-cols-2">
          {orders.map((o) => {
            const handovers = nextHandovers(o.orderType, o.stage)
            return (
              <li key={o.orderId} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-base font-semibold">
                    {o.orderType === 'delivery' ? <Bike size={15} className="text-violet-600" /> : <ShoppingBag size={15} className="text-amber-600" />}
                    {o.orderNumber}
                    <OrderTypeBadge orderType={o.orderType} />
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STAGE_BADGE[o.stage]}`}>{STAGE_LABEL[o.stage]}</span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{o.contactName ?? 'Customer'}</span>
                  {o.contactPhone && (
                    <a href={`tel:${o.contactPhone}`} className="inline-flex items-center gap-1 hover:underline">
                      <Phone size={12} /> {o.contactPhone}
                    </a>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} /> {mins(o.createdAt)}m ago{o.pickupAt ? ` · for ${time(o.pickupAt)}` : ''}
                  </span>
                  {o.channel === 'online' && <span className="rounded-full bg-primary/10 px-2 text-[10px] font-bold uppercase text-primary">Online</span>}
                </p>
                {o.deliveryAddress && (
                  <p className="mt-1 flex items-start gap-1 text-sm">
                    <MapPin size={13} className="mt-0.5 shrink-0 text-muted-foreground" /> {o.deliveryAddress}
                  </p>
                )}
                {o.driverName && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Driver: {o.driverName}
                    {o.driverPhone ? ` · ${o.driverPhone}` : ''}
                  </p>
                )}
                <ul className="mt-3 space-y-0.5 text-sm">
                  {o.items.map((i, idx) => (
                    <li key={idx}>
                      <span className="font-medium">{i.qty}×</span> {i.name}
                      {i.modifiers.length > 0 && <span className="text-muted-foreground"> ({i.modifiers.join(', ')})</span>}
                      {i.notes && <span className="text-muted-foreground"> — {i.notes}</span>}
                    </li>
                  ))}
                </ul>
                {o.notes && <p className="mt-2 rounded-md bg-muted px-2 py-1 text-sm">{o.notes}</p>}
                {o.deliveryFee > 0 && <p className="mt-2 text-xs text-muted-foreground">Delivery charge {formatMoney(o.deliveryFee, currency)} (plus GST) on the bill</p>}

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {o.paid ? (
                    <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600">Paid</span>
                  ) : (
                    <button
                      disabled={pending}
                      onClick={() => act(() => collectOrderPayment({ orderId: o.orderId, method: payMethod, idempotencyKey: `pay-${o.orderId}-${payMethod}` }), 'Payment recorded.')}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Take payment
                    </button>
                  )}
                  {handovers.map((h) => (
                    <button
                      key={h}
                      disabled={pending}
                      onClick={() => (h === 'out_for_delivery' ? setDriverFor(o.orderId) : act(() => handoverOrder({ orderId: o.orderId, to: h as HandoverStatus }), 'Done.'))}
                      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {HANDOVER_LABEL[h]}
                    </button>
                  ))}
                  {!o.paid && o.stage === 'received' && (
                    <button
                      disabled={pending}
                      onClick={() => window.confirm(`Cancel ${o.orderNumber}?`) && act(() => cancelTypedOrder(o.orderId), 'Order cancelled.')}
                      className="ml-auto rounded-md px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {o.stage === 'ready' && !o.paid && <p className="mt-2 text-xs text-muted-foreground">Unpaid — take payment before or when handing over.</p>}
              </li>
            )
          })}
        </ul>
      )}

      {newOpen && !details && (
        <DetailsDialog
          takeawayEnabled={takeawayEnabled}
          deliveryEnabled={deliveryEnabled}
          defaultFee={defaultFee}
          feeTaxRate={feeTaxRate}
          currency={currency}
          onClose={() => setNewOpen(false)}
          onContinue={(d) => {
            setDetails(d)
            setPicking(true)
          }}
        />
      )}
      {details && picking && (
        <TakeOrderDialog
          branchId={branchId}
          currency={currency}
          categories={categories}
          menuItems={menuItems}
          happyHours={happyHours}
          timeZone={timeZone}
          headerNote={`${details.orderType === 'delivery' ? 'Delivery' : 'Takeaway'} for ${details.contactName} — no table.`}
          placeOrder={(items, idempotencyKey) =>
            createTypedOrder({
              branchId,
              orderType: details.orderType,
              contactName: details.contactName,
              contactPhone: details.contactPhone || undefined,
              pickupAt: details.pickupAt,
              deliveryAddress: details.orderType === 'delivery' ? details.deliveryAddress : undefined,
              deliveryFee: details.orderType === 'delivery' ? details.deliveryFee : undefined,
              notes: details.notes || undefined,
              idempotencyKey,
              items,
            })
          }
          onClose={() => {
            setPicking(false)
            setDetails(null)
            setNewOpen(false)
          }}
          onCreated={(n) => {
            setPicking(false)
            setDetails(null)
            setNewOpen(false)
            toast.success(`Order ${n} sent to the kitchen.`)
            router.refresh()
          }}
        />
      )}
      {driverFor && (
        <DriverDialog
          pending={pending}
          onClose={() => setDriverFor(null)}
          onSubmit={(name, phone) => {
            const id = driverFor
            setDriverFor(null)
            act(() => handoverOrder({ orderId: id, to: 'out_for_delivery', driverName: name, driverPhone: phone || undefined }), 'Sent out for delivery.')
          }}
        />
      )}
    </div>
  )
}
