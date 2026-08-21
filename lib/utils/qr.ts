import 'server-only'
import QRCode from 'qrcode'

/**
 * Render `data` (a URL) as an inline SVG string — used for the booking
 * confirmation page's scannable code. SVG over a PNG data URL: crisp at any
 * size, no separate image request, and trivial to theme via `color`.
 */
export async function generateQrSvg(data: string): Promise<string> {
  return QRCode.toString(data, {
    type: 'svg',
    margin: 1,
    color: { dark: '#1b1524', light: '#ffffff' },
  })
}
