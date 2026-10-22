/**
 * Minimal ESC/POS byte builder for 58/80mm thermal printers (M19 / AROS-175).
 *
 * Pure and dependency-free so it can be unit-tested and rendered anywhere. All
 * text is forced to printable ASCII: the printer's code page is unknowable from
 * here (and ₹ is not in CP437), so rather than print garbage we transliterate
 * (₹ → "Rs", × → "x", accents stripped) and replace anything left with "?".
 *
 * Commands used (the common ESC/POS core every compatible printer supports):
 *   ESC @        initialise            ESC a n    align (0 left, 1 centre, 2 right)
 *   ESC E n      bold                  GS ! n     character size (w-1)<<4 | (h-1)
 *   ESC d n      feed n lines          GS V B n   partial cut after feeding
 */

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

/** Printable-ASCII transliteration. Exported for tests. */
export function toAscii(input: string): string {
  const mapped = input
    .replace(/₹/g, 'Rs ')
    .replace(/[×✕]/g, 'x')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '*')
    .replace(/ /g, ' ')
  return mapped
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\r\t]/g, ' ')
    .replace(/[^\x20-\x7e\n]/gu, '?')
}

/** Word-wrap to `width` columns; words longer than a line are hard-split. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of toAscii(text).split('\n')) {
    let line = ''
    for (let word of para.split(/ +/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

export class EscPos {
  private bytes: number[] = []
  /** Characters per line at normal size — double-width text halves this. */
  readonly width: number

  constructor(width = 42) {
    this.width = width
    this.raw(ESC, 0x40) // initialise
  }

  private raw(...b: number[]): this {
    this.bytes.push(...b)
    return this
  }

  align(a: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2)
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0)
  }

  /** 1 = normal, 2 = double. Width and height are set together. */
  size(n: 1 | 2): this {
    return this.raw(GS, 0x21, n === 2 ? 0x11 : 0x00)
  }

  /** Raw text, no newline. */
  write(text: string): this {
    for (const ch of toAscii(text)) this.bytes.push(ch === '\n' ? LF : ch.charCodeAt(0))
    return this
  }

  /** Wrapped text lines, each ended with a newline. `cols` = effective width. */
  line(text = '', cols = this.width): this {
    for (const l of wrap(text, cols)) this.write(l).raw(LF)
    return this
  }

  /** "left ........ right" on one line (left wraps if it can't fit). */
  row(left: string, right: string, cols = this.width): this {
    const r = toAscii(right)
    const room = Math.max(1, cols - r.length - 1)
    const parts = wrap(left, room)
    parts.forEach((p, i) => {
      const isLast = i === parts.length - 1
      this.write(isLast ? p.padEnd(cols - r.length, ' ') + r : p).raw(LF)
    })
    return this
  }

  rule(ch = '-'): this {
    return this.write(ch.repeat(this.width)).raw(LF)
  }

  feed(n = 1): this {
    return this.raw(ESC, 0x64, Math.max(0, Math.min(255, n)))
  }

  /** Feed past the cutter, then partial-cut. */
  cut(): this {
    return this.feed(4).raw(GS, 0x56, 0x42, 0x00)
  }

  build(): Buffer {
    return Buffer.from(this.bytes)
  }
}
