'use client'

import { useEffect } from 'react'

/**
 * Locks page scroll for as long as the calling component (a modal/dialog) is
 * mounted. The app shell scrolls inside `#app-main-scroll` (its own
 * `overflow-y-auto` container), not the document body, so both are locked —
 * the body for pages outside the shell, the shell container for pages inside it.
 */
export function useBodyScrollLock() {
  useEffect(() => {
    const targets = [document.body, document.getElementById('app-main-scroll')].filter(
      (el): el is HTMLElement => !!el,
    )
    const originals = targets.map((el) => el.style.overflow)
    for (const el of targets) el.style.overflow = 'hidden'
    return () => {
      targets.forEach((el, i) => {
        el.style.overflow = originals[i]
      })
    }
  }, [])
}
