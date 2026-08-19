export function formatMoney(amount: number | string, currency = 'INR'): string {
  const n = typeof amount === 'string' ? Number(amount) : amount
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

export function timeInZone(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

/** 'YYYY-MM' → 'August 2026'. UTC throughout — a calendar month has no timezone of its own. */
export function formatPayrollPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** 'YYYY-MM' shifted by `delta` calendar months (negative moves back). UTC — a month has no timezone. */
export function shiftPayrollPeriod(period: string, delta: number): string {
  const [year, month] = period.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function prettyDate(dateStr: string, timeZone: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)))
}
