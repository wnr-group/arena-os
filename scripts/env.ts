import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Minimal .env loader for standalone scripts (tsx doesn't load .env the way
 * Next.js does). Later files do not override already-set vars.
 */
export function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8')
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
        }
      }
    } catch {
      /* file may not exist; ignore */
    }
  }
}
