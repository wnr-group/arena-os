/**
 * Edge proxy: /reserve (public "Book a table") must render for an anonymous
 * visitor instead of bouncing to the staff login, and POSTs to it must fall
 * under the public-route rate limit. Pure — no database.
 */
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failed++
    if (detail !== undefined) console.log('      ', detail)
  }
}

const host = `acme.${process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000'}`
const req = (path: string, method = 'GET', ip = '10.0.0.1') =>
  new NextRequest(`http://${host}${path}`, { method, headers: { host, 'x-forwarded-for': ip } })

const isLoginRedirect = (res: Response) =>
  res.status >= 300 && res.status < 400 && (res.headers.get('location') ?? '').includes('/login')

const anon = proxy(req('/reserve'))
check('anonymous GET /reserve is not redirected to login', !isLoginRedirect(anon), anon.headers.get('location'))
check('anonymous GET /reserve passes through', anon.status === 200, anon.status)

const guard = proxy(req('/settings'))
check('control: anonymous /settings still redirects to login', isLoginRedirect(guard))

let limited = false
for (let i = 0; i < 70; i++) {
  if (proxy(req('/reserve', 'POST', '10.0.0.99')).status === 429) { limited = true; break }
}
check('POSTs to /reserve are rate limited', limited)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
