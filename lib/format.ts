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
