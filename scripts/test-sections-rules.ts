/**
 * Pure floor-section rules (M20 / AROS-178) — no database.
 *
 *   npx tsx scripts/test-sections-rules.ts
 */
import { canBeServer, effectiveServerId, groupTablesBySection, validateSectionName } from '../lib/sections/rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

check('table-level server wins over the section', effectiveServerId('t', 's') === 't')
check('falls back to the section server', effectiveServerId(null, 's') === 's')
check('nobody assigned -> null', effectiveServerId(null, null) === null)

check('floor staff can be a server', canBeServer('floor_staff') && canBeServer('manager') && canBeServer('cashier'))
check('kitchen staff cannot', !canBeServer('kitchen_staff'))
check('unknown/empty role cannot', !canBeServer('') && !canBeServer(null) && !canBeServer(undefined))

check('blank section name refused', validateSectionName('  ') !== null)
check('over-long section name refused', validateSectionName('x'.repeat(61)) !== null)
check('normal section name ok', validateSectionName('Patio') === null)

type Row = { id: string; sectionId: string | null; sectionName: string | null; sectionSort: number | null }
const r = (id: string, sectionId: string | null, name: string | null, sort: number | null): Row => ({ id, sectionId, sectionName: name, sectionSort: sort })

const flat = [r('1', null, null, null), r('2', null, null, null)]
const g0 = groupTablesBySection(flat)
check('no sections -> one headingless group, order untouched (floor unchanged)', g0.length === 1 && g0[0].name === null && g0[0].tables.map((t) => t.id).join() === '1,2')

const mixed = [
  r('1', 'bar', 'Bar', 2),
  r('2', null, null, null),
  r('3', 'main', 'Main dining', 0),
  r('4', 'patio', 'Patio', 1),
  r('5', 'main', 'Main dining', 0),
]
const g = groupTablesBySection(mixed)
check('groups follow section order, unsectioned last', g.map((x) => x.name).join('|') === 'Main dining|Patio|Bar|Other tables')
check('table order inside a group is preserved', g[0].tables.map((t) => t.id).join() === '3,5')
check('every table appears exactly once', g.reduce((n, x) => n + x.tables.length, 0) === mixed.length)
check('ties in sort order fall back to name', groupTablesBySection([r('1', 'b', 'Beta', 0), r('2', 'a', 'Alpha', 0)]).map((x) => x.name).join() === 'Alpha,Beta')
check('all tables sectioned -> no "Other tables" group', groupTablesBySection([r('1', 'a', 'A', 0)]).every((x) => x.name !== 'Other tables'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
