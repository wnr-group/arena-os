/**
 * M35 #9 — the pure rules behind the setup photo manager UI
 * (lib/booking/setup-photo-ui.ts): client-side file pre-check, queueing a
 * multi-select against the remaining slots, and reordering. No DB, no React.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-setup-photo-ui.ts
 */
import { checkPhotoFile, movePhoto, planUploads, SETUP_PHOTO_MAX, SETUP_PHOTO_MAX_BYTES } from '../lib/booking/setup-photo-ui'
import { IMAGE_POLICY, IMAGE_TYPES } from '../lib/storage/s3'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

// the UI's limits must match the server's, or the pre-check would lie
check('client size limit equals the server IMAGE_POLICY', SETUP_PHOTO_MAX_BYTES === IMAGE_POLICY.maxBytes)
check('client accepts exactly the types the server accepts', Object.keys(IMAGE_TYPES).every((t) => checkPhotoFile({ type: t, size: 100 }) === null) && checkPhotoFile({ type: 'image/svg+xml', size: 100 }) !== null)

check('wrong type refused', /JPEG, PNG, WEBP or GIF/.test(checkPhotoFile({ type: 'application/pdf', size: 100 }) ?? ''))
check('empty file refused', /empty/.test(checkPhotoFile({ type: 'image/png', size: 0 }) ?? ''))
check('5MB exactly is allowed, 1 byte over is refused', checkPhotoFile({ type: 'image/png', size: SETUP_PHOTO_MAX_BYTES }) === null && /5MB/.test(checkPhotoFile({ type: 'image/png', size: SETUP_PHOTO_MAX_BYTES + 1 }) ?? ''))

check('cap is 3', SETUP_PHOTO_MAX === 3)
const files = ['a', 'b', 'c', 'd', 'e']
check('0 existing + 5 selected: first 3 queued, 2 ignored', JSON.stringify(planUploads(0, files)) === JSON.stringify({ accepted: ['a', 'b', 'c'], skipped: 2 }))
check('2 existing + 3 selected: only 1 queued, 2 ignored', JSON.stringify(planUploads(2, ['a', 'b', 'c'])) === JSON.stringify({ accepted: ['a'], skipped: 2 }))
check('3 existing: nothing queued, everything ignored', JSON.stringify(planUploads(3, ['a'])) === JSON.stringify({ accepted: [], skipped: 1 }))
check('more existing than the cap never goes negative', planUploads(9, ['a']).accepted.length === 0)
check('order of selection is preserved', planUploads(1, ['x', 'y', 'z']).accepted.join() === 'x,y')

const list = ['p1', 'p2', 'p3']
check('move photo 2 left puts it first (new cover)', movePhoto(list, 1, -1)?.join() === 'p2,p1,p3')
check('move photo 1 right', movePhoto(list, 0, 1)?.join() === 'p2,p1,p3')
check('move photo 2 right swaps with 3', movePhoto(list, 1, 1)?.join() === 'p1,p3,p2')
check('cannot move the first left or the last right', movePhoto(list, 0, -1) === null && movePhoto(list, 2, 1) === null)
check('bad index is refused', movePhoto(list, 5, -1) === null && movePhoto(list, -1, 1) === null)
check('does not mutate its input', list.join() === 'p1,p2,p3')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
