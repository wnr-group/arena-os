/**
 * M35 #3 — StorefrontSetupCards render checks (static markup, no DB).
 *   npx tsx scripts/test-storefront-cards.tsx
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { StorefrontSetupCards } from '../components/public-booking/StorefrontSetupCards'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${String(got).slice(0, 400)})`}`)
  if (c) pass++
  else fail++
}
const type = (id: string, name: string, resources: { id: string; name: string }[]) => ({
  id, name, description: null, capacity: 4, imageUrl: null, hourlyRate: '500.00', resources,
})
const setup = (id: string, name: string, resourceId: string, resourceName: string, typeId: string, rate: string, unit: 'hour' | 'day') => ({
  setupId: id, setupName: name, rate, rateUnit: unit, resourceId, resourceName,
  resourceTypeId: typeId, resourceTypeName: 'Studio', imageUrl: null, images: [], capacity: null, description: null,
})
const render = (p: Parameters<typeof StorefrontSetupCards>[0]) => renderToStaticMarkup(<StorefrontSetupCards {...p} />)

const t1 = type('t1', 'Studio', [{ id: 'rA', name: 'Studio A' }, { id: 'rB', name: 'Studio B' }, { id: 'rC', name: 'Studio C' }])
const setups = [
  setup('s1', 'Podcast Setup', 'rA', 'Studio A', 't1', '800.00', 'hour'),
  setup('s2', 'Podcast Setup', 'rB', 'Studio B', 't1', '800.00', 'hour'),
  setup('s3', 'Royal', 'rA', 'Studio A', 't1', '6000.00', 'day'),
]
const addons = [
  { id: 'a1', resourceTypeId: 't1', name: 'Camera', rate: '300.00', rateUnit: 'hour' as const },
  { id: 'a2', resourceTypeId: 't1', name: 'Lens', rate: '150.00', rateUnit: 'day' as const },
]
const html = render({ types: [t1], setups, addons, currency: 'INR' })
check('3 setup cards + 1 plain card for the set with no setups', (html.match(/<a /g) ?? []).length === 4, html.match(/<a /g)?.length)
check('setup links go straight to /book/[set]?setup=[id]', html.includes('href="/book/rA?setup=s1"') && html.includes('href="/book/rB?setup=s2"'))
check('empty set still bookable via plain /book/[set] card', html.includes('href="/book/rC"'))
check('same-named setups are labelled by set', html.includes('Studio A') && html.includes('Studio B'))
check('hour / day rates formatted', html.includes('₹800 / hr') && html.includes('₹6,000 / day'), html)
check('add-ons strip lists name + rate', html.includes('Also available:') && html.includes('Camera ₹300/hr') && html.includes('Lens ₹150/day'))
check('single type: no type heading', !html.includes('<h2'))
check('no stock wording', !/stock|left|available:\s*\d/i.test(html.replace('Also available:', '')))
check('no add-ons strip when none', !render({ types: [t1], setups, addons: [], currency: 'INR' }).includes('Also available'))

const t2 = type('t2', 'Booth', [{ id: 'rX', name: 'Booth 1' }])
const multi = render({ types: [t1, t2], setups, addons, currency: 'INR' })
check('multiple types: headings per type, strip only under the type with add-ons', (multi.match(/<h2/g) ?? []).length === 2 && (multi.match(/Also available/g) ?? []).length === 1)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
