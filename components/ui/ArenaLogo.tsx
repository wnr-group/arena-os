import { useId } from 'react'

/**
 * The ArenaOS brand mark — a nine-part geometric monogram in wine/aubergine
 * with a gold sphere, on a 1456x1370 grid. Transparent by design (no
 * background shape baked in), so it can sit on any surface.
 *
 * Gradient/title ids are namespaced per-instance via useId() so the mark can
 * render more than once on the same page (e.g. navbar + footer) without
 * colliding <defs> ids.
 */
export function ArenaLogo({ className, title = 'ArenaOS' }: { className?: string; title?: string }) {
  const uid = useId()
  const id = (name: string) => `arena-logo-${name}-${uid}`
  const titleId = id('title')

  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1456 1370" role="img" aria-labelledby={titleId} className={className}>
      <title id={titleId}>{title}</title>
      <defs>
        <linearGradient id={id('gPlum')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#61305C" />
          <stop offset="1" stopColor="#2C0D34" />
        </linearGradient>
        <linearGradient id={id('gInkTop')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1E0526" />
          <stop offset="1" stopColor="#2C0A18" />
        </linearGradient>
        <linearGradient id={id('gInkBottom')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1B0424" />
          <stop offset="1" stopColor="#2A0918" />
        </linearGradient>
        <linearGradient id={id('gWineTall')} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#7E1F42" />
          <stop offset="1" stopColor="#4E0F26" />
        </linearGradient>
        <linearGradient id={id('gMaroon')} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#7C1937" />
          <stop offset="1" stopColor="#581026" />
        </linearGradient>
        <linearGradient id={id('gWineDeep')} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#4E0E22" />
          <stop offset="1" stopColor="#2B0611" />
        </linearGradient>
        <radialGradient id={id('gGold')} cx="0.36" cy="0.3" r="0.82">
          <stop offset="0" stopColor="#F2C75B" />
          <stop offset="0.5" stopColor="#E0A72F" />
          <stop offset="1" stopColor="#C4881A" />
        </radialGradient>
      </defs>
      <path fill={`url(#${id('gPlum')})`} d="M495 45 H292.5 A202.5 202.5 0 0 0 292.5 450 H495 Z" />
      <rect x="530" y="45" width="405" height="405" rx="90" fill={`url(#${id('gInkTop')})`} />
      <path
        fill={`url(#${id('gWineTall')})`}
        d="M970 45 H1070 A300 300 0 0 1 1370 345 V825 A60 60 0 0 1 1310 885 H1030 A60 60 0 0 1 970 825 Z"
      />
      <circle cx="1192" cy="645" r="157" fill={`url(#${id('gGold')})`} />
      <path
        fill={`url(#${id('gMaroon')})`}
        d="M90 480 H935 V790 A90 90 0 0 1 845 880 H620 A125 125 0 0 0 495 1005 V1230 A90 90 0 0 1 405 1320 H290 A200 200 0 0 1 90 1120 Z"
      />
      <rect x="530" y="925" width="405" height="395" rx="90" fill={`url(#${id('gInkBottom')})`} />
      <path
        fill={`url(#${id('gWineDeep')})`}
        d="M970 925 H1370 V1030 A290 290 0 0 1 1080 1320 H1030 A60 60 0 0 1 970 1260 Z"
      />
    </svg>
  )
}
