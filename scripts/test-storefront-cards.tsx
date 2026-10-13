/**
 * M35 #3 — StorefrontSetupCards render checks (static markup, no DB).
 *   npx tsx scripts/test-storefront-cards.tsx
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { StorefrontSetupCards } from '../components/public-booking/StorefrontSetupCards'
import { PhotoGallery } from '../components/public-booking/PhotoGallery'
import { ResourceUnitPicker } from '../components/public-booking/ResourceUnitPicker'

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
// ── M35 #10: photos on cards — three fallback tiers ──────────────────────────
const photoCard = (images: string[], imageUrl: string | null, typeImage: string | null = null) =>
  render({
    types: [{ ...t1, imageUrl: typeImage, resources: [{ id: 'rA', name: 'Studio A' }] }],
    setups: [{ ...setup('s1', 'Podcast Setup', 'rA', 'Studio A', 't1', '800.00', 'hour'), images, imageUrl }],
    addons: [],
    currency: 'INR',
  })
const tier1 = photoCard(['https://img.test/cover.jpg', 'https://img.test/2.jpg'], 'https://img.test/set.jpg')
check('tier 1: the setup cover (position 1) is the card image', tier1.includes('src="https://img.test/cover.jpg"') && !tier1.includes('set.jpg'), tier1)
check('card is lazy-loaded with a fixed 4:3 box', tier1.includes('loading="lazy"') && tier1.includes('aspect-[4/3]'))
check('"2 photos" hint when more than one exists', tier1.includes('2 photos'))
const tier2 = photoCard([], 'https://img.test/set.jpg')
check('tier 2: no photos -> the set/type image', tier2.includes('src="https://img.test/set.jpg"') && !tier2.includes('photos<'), tier2)
const tier3 = photoCard([], null)
check('tier 3: nothing at all -> the icon placeholder, no <img>', !tier3.includes('<img') && tier3.includes('<svg'), tier3)
check('a single photo shows no count hint', !photoCard(['https://img.test/only.jpg'], null).includes('photos<'))

// ── the gallery ──────────────────────────────────────────────────────────────
const gal = (n: number) =>
  renderToStaticMarkup(<PhotoGallery images={Array.from({ length: n }, (_, i) => `https://img.test/g${i + 1}.jpg`)} name="Royal" />)
const g1 = gal(1)
const g2 = gal(2)
const g3 = gal(3)
check('gallery with 1 photo: one slide, no thumbnails or arrows', (g1.match(/<img/g) ?? []).length === 1 && !g1.includes('Previous photo') && !g1.includes('Show photo'), g1)
check('gallery with 2 photos: 2 slides + 2 thumbnails + arrows', (g2.match(/<img/g) ?? []).length === 4 && g2.includes('Previous photo') && g2.includes('Next photo') && g2.includes('Show photo 2 of 2'))
check('gallery with 3 photos: 3 slides + 3 thumbnails', (g3.match(/<img/g) ?? []).length === 6 && g3.includes('Show photo 3 of 3'))
check('descriptive alt text "{name} — photo N of M"', g3.includes('alt="Royal — photo 2 of 3"') && g3.includes('alt="Royal — photo 3 of 3"'))
check(
  'first slide eager, the rest lazy',
  g3.includes('alt="Royal — photo 1 of 3" loading="eager"') && g3.includes('alt="Royal — photo 2 of 3" loading="lazy"') && g3.includes('alt="Royal — photo 3 of 3" loading="lazy"'),
  g3,
)
check('every slide reserves a 4:3 box and is a button that enlarges', g3.split('aspect-[4/3]').length - 1 >= 6 && g3.includes('aria-label="Enlarge Royal — photo 1 of 3"'))
check('no photos renders nothing', renderToStaticMarkup(<PhotoGallery images={[]} name="x" />) === '')
check('the lightbox is closed until a slide is tapped', !g3.includes('role="dialog"'))

// ── the legacy "Choose a set" picker ─────────────────────────────────────────
const picker = renderToStaticMarkup(
  <ResourceUnitPicker
    tenant={{ currency: 'INR' } as never}
    resourceType={{ name: 'Studio', description: null, hourlyRate: '500.00' } as never}
    units={[
      {
        id: 'u1',
        name: 'Set A',
        setups: [
          { id: 'a', name: 'With photo', rate: '800.00', rateUnit: 'hour', images: ['https://img.test/p.jpg', 'https://img.test/q.jpg'] },
          { id: 'b', name: 'No photo', rate: '6000.00', rateUnit: 'day', images: [] },
        ],
      },
    ]}
  />,
)
check(
  'unit picker: a setup with photos shows its cover thumbnail, one without shows none',
  (picker.match(/<img/g) ?? []).length === 1 && picker.includes('src="https://img.test/p.jpg"') && picker.includes('With photo') && picker.includes('No photo'),
  picker,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
