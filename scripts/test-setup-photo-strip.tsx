/**
 * M35 #9 — static render checks for the setup photo manager
 * (components/settings/SetupPhotoStrip.tsx, ResourceSetupsModal.tsx): the
 * structure, labels and cap a manager sees. Renders with a stub app router and
 * the real ConfirmDialogProvider; interaction (upload / reorder / remove) is
 * covered by the action tests (test-setup-photo-actions.ts) and the pure rules
 * test (test-setup-photo-ui.ts).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-setup-photo-strip.tsx
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${String(got).slice(0, 300)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { SetupPhotoStrip } = await import('../components/settings/SetupPhotoStrip')
  const { ResourceSetupsModal } = await import('../components/settings/ResourceSetupsModal')
  const { ConfirmDialogProvider } = await import('../components/ui/ConfirmDialog')

  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }
  const render = (el: React.ReactElement) =>
    renderToStaticMarkup(
      createElement(AppRouterContext.Provider, { value: router as never }, createElement(ConfirmDialogProvider, null, el)),
    )
  const photo = (n: number) => ({ id: `id-${n}`, url: `https://img.test/${n}.jpg` })
  const strip = (photos: { id: string; url: string }[], setupId: string | null = 'setup-1') =>
    render(<SetupPhotoStrip setupId={setupId} setupName="Podcast" photos={photos} />)
  const count = (html: string, needle: string) => html.split(needle).length - 1

  // ── 2 photos: cover label, per-photo controls, one open slot ─────────────
  const two = strip([photo(1), photo(2)])
  check('2/3 counter', two.includes('2/3'))
  check('first photo is labelled Cover, the second is not', count(two, '>Cover<') === 1 && two.includes('photo 1 (cover)') && !two.includes('photo 2 (cover)'))
  check('thumbnails carry alt text and are lazy', two.includes('alt="Podcast photo 1 (cover)"') && two.includes('alt="Podcast photo 2"') && count(two, 'loading="lazy"') === 2)
  check('accessible per-photo buttons', ['Move photo 1 left', 'Move photo 1 right', 'Remove photo 1', 'Move photo 2 left', 'Move photo 2 right', 'Remove photo 2'].every((l) => two.includes(`aria-label="${l}"`)))
  check('cover cannot move left, last cannot move right (disabled)', /aria-label="Move photo 1 left"[^>]*disabled|disabled=""[^>]*aria-label="Move photo 1 left"/.test(two) && /disabled=""[^>]*aria-label="Move photo 2 right"|aria-label="Move photo 2 right"[^>]*disabled/.test(two))
  check('exactly one "+ Add photo" slot while 2 of 3 are used', count(two, '+ Add photo') === 1)
  check('picker accepts only the 4 image types', two.includes('accept="image/jpeg,image/png,image/webp,image/gif"') && two.includes('multiple'))

  // ── full: the add control is gone ────────────────────────────────────────
  const three = strip([photo(1), photo(2), photo(3)])
  check('3/3: no "+ Add photo" and no file input at all', !three.includes('+ Add photo') && !three.includes('type="file"') && three.includes('3/3'))

  // ── empty ────────────────────────────────────────────────────────────────
  const none = strip([])
  check('0 photos: three add slots and a hint', count(none, '+ Add photo') === 3 && /5MB each/.test(none) && none.includes('0/3'))

  // ── unsaved setup ────────────────────────────────────────────────────────
  const draft = strip([], null)
  check('unsaved setup: add control disabled with the helper text', draft.includes('Save the setup first, then add photos.') && count(draft, 'disabled=""') >= 3)

  // ── in the modal ─────────────────────────────────────────────────────────
  const rows = [
    { id: 's1', resourceId: 'r1', name: 'Podcast Setup', rate: '800.00', rateUnit: 'hour' as const, isActive: true, sortOrder: 0, photos: [photo(1), photo(2)] },
    { id: 's2', resourceId: 'r1', name: 'Royal', rate: '6000.00', rateUnit: 'day' as const, isActive: true, sortOrder: 1, photos: [] },
  ]
  const modal = render(<ResourceSetupsModal resourceId="r1" resourceName="Set A" currency="INR" setups={rows} onClose={() => {}} />)
  check('modal shows a photo strip under every saved setup', count(modal, '>Photos<') === 2)
  check("each strip is bound to its own setup's photos", modal.includes('alt="Podcast Setup photo 1 (cover)"') && !modal.includes('alt="Royal photo 1'))
  check('the existing setup list is still there (names, rates)', modal.includes('Podcast Setup') && modal.includes('Royal') && modal.includes('/ day'))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
