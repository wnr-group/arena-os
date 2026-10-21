'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** Adaptive polling for a wall display: refresh the server data every `ms`
 *  while the tab is visible, pause while it's hidden, and refresh immediately
 *  when it becomes visible again. */
export function usePolling(ms: number) {
  const router = useRouter()
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), ms)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        router.refresh()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router, ms])
}
