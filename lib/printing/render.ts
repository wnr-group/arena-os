/**
 * Print layouts: a kitchen ticket and a customer receipt/bill as ESC/POS bytes
 * (M19 / AROS-175). Pure functions of plain data — no database, no clock — so
 * the exact bytes a printer receives are reproducible and unit-testable.
 */
import { EscPos } from './escpos'

export type TicketLine = {
  qty: number
  name: string
  modifiers: string[]
  notes: string | null
  courseName: string | null
}

export type KitchenTicketData = {
  kotNumber: string
  orderNumber: string
  /** Table / station label the order belongs to, if any. */
  tableName: string | null
  /** The prep station this paper is for (header), if routing is on. */
  stationName: string | null
  channel: 'staff' | 'online'
  /** Pre-formatted in the venue's timezone, e.g. "7:42 PM". */
  time: string
  /** 'new' for a fresh order, 'fire' when a held course was just fired, 'reprint'. */
  reason: 'new' | 'fire' | 'reprint'
  lines: TicketLine[]
}

export function renderKitchenTicket(d: KitchenTicketData, width = 42): Buffer {
  const p = new EscPos(width)
  const half = Math.floor(width / 2)

  if (d.stationName) {
    p.align('center').bold(true).size(2).line(d.stationName.toUpperCase(), half).size(1).bold(false)
  }
  p.align('left').bold(true).size(2).line(d.tableName ? `${d.kotNumber}  ${d.tableName}` : d.kotNumber, half).size(1).bold(false)
  p.row(`Order ${d.orderNumber}${d.channel === 'online' ? '  ONLINE' : ''}`, d.time)
  if (d.reason !== 'new') {
    p.bold(true).line(d.reason === 'fire' ? '*** FIRE ***' : '*** REPRINT ***').bold(false)
  }
  p.rule()

  let course: string | null | undefined
  for (const l of d.lines) {
    if (l.courseName && l.courseName !== course) {
      p.bold(true).line(`-- ${l.courseName.toUpperCase()} --`).bold(false)
    }
    course = l.courseName
    p.bold(true).size(2).line(`${l.qty} x ${l.name}`, half).size(1).bold(false)
    for (const m of l.modifiers) p.line(`   + ${m}`)
    if (l.notes) p.bold(true).line(`   ! ${l.notes}`).bold(false)
  }
  p.rule().cut()
  return p.build()
}

export type ReceiptData = {
  business: { name: string; address: string | null; phone: string | null; gstin: string | null }
  invoiceNumber: string
  /** Pre-formatted date/time in the venue's timezone. */
  date: string
  customer: string | null
  items: { description: string; qty: string; unitPrice: string; lineTotal: string }[]
  subtotal: string
  discount: string
  serviceCharge: string
  cgst: string
  sgst: string
  total: string
  payments: { method: string; amount: string }[]
  paid: string
  balanceDue: string
  /** True when the printed paper is a bill awaiting payment, not a paid receipt. */
  isBill: boolean
}

const money = (v: string | number) => `Rs ${Number(v).toFixed(2)}`
const qtyText = (q: string) => (Number.isFinite(Number(q)) ? String(Number(q)) : q)

export function renderReceipt(d: ReceiptData, width = 42): Buffer {
  const p = new EscPos(width)
  const half = Math.floor(width / 2)

  p.align('center').bold(true).size(2).line(d.business.name, half).size(1).bold(false)
  if (d.business.address) p.line(d.business.address)
  if (d.business.phone) p.line(`Tel ${d.business.phone}`)
  if (d.business.gstin) p.line(`GSTIN ${d.business.gstin}`)
  p.align('left').rule()
  p.row(d.isBill ? 'BILL' : 'RECEIPT', d.invoiceNumber)
  p.line(d.date)
  if (d.customer) p.line(`Customer: ${d.customer}`)
  p.rule()

  for (const it of d.items) {
    p.line(it.description)
    p.row(`  ${qtyText(it.qty)} x ${Number(it.unitPrice).toFixed(2)}`, Number(it.lineTotal).toFixed(2))
  }
  p.rule()

  p.row('Subtotal', Number(d.subtotal).toFixed(2))
  if (Number(d.discount) > 0) p.row('Discount', `-${Number(d.discount).toFixed(2)}`)
  if (Number(d.serviceCharge) > 0) p.row('Service charge', Number(d.serviceCharge).toFixed(2))
  if (Number(d.cgst) > 0) p.row('CGST', Number(d.cgst).toFixed(2))
  if (Number(d.sgst) > 0) p.row('SGST', Number(d.sgst).toFixed(2))
  p.bold(true).size(2).row('TOTAL', Number(d.total).toFixed(2), half).size(1).bold(false)
  p.rule()

  for (const pay of d.payments) p.row(pay.method, Number(pay.amount).toFixed(2))
  if (d.payments.length > 0) p.row('Paid', Number(d.paid).toFixed(2))
  if (Number(d.balanceDue) > 0) p.bold(true).row('BALANCE DUE', money(d.balanceDue)).bold(false)

  p.feed(1).align('center').line(d.isBill ? 'Please pay at the counter' : 'Thank you!').cut()
  return p.build()
}
