import type { CSSProperties } from 'react'

const HEX_PATTERN = /^#([0-9a-fA-F]{6})$/

/**
 * Picks black or white text against an arbitrary tenant-chosen accent
 * colour, using WCAG relative luminance. A simple threshold — not a full
 * contrast-ratio check — but enough to keep a "Book Now" button on a pale
 * accent from rendering white-on-white.
 */
export function getContrastText(hex: string): '#000000' | '#ffffff' {
  const match = HEX_PATTERN.exec(hex)
  if (!match) return '#ffffff'
  const [r, g, b] = [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)].map((h) => parseInt(h, 16) / 255)
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
  return luminance > 0.5 ? '#000000' : '#ffffff'
}

/**
 * The tenant's accent colour as a `--primary`/`--primary-foreground`
 * override — every public page applies this to its root element so the
 * tenant's brand colour (buttons, links, highlights) is consistent
 * everywhere, not only on the website-builder homepage. `undefined` (no
 * style override, falls through to the default theme) when no accent
 * colour is set.
 */
export function accentColorStyle(accentColor: string | null): CSSProperties | undefined {
  return accentColor
    ? ({ '--primary': accentColor, '--primary-foreground': getContrastText(accentColor) } as CSSProperties)
    : undefined
}
